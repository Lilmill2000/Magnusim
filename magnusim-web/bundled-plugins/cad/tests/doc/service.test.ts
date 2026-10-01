// The document service over a fake host and a fake kernel: storage outside
// the study record, panel sessions (live apply, one undo step), edits and
// their guards, parameters, undo/redo, autosave, conflicts, view state, G1.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { SAVE_BURST } from '../../src/doc/autosave';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import type { BoxFeature, CylinderFeature } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace, type FakeWorkspace } from '../fakes/workspace-sdk';
import { FakeKernel } from './fake-kernel';

const MODEL = 'studies/st-test/model.json';
const VIEW = 'studies/st-test/view.json';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
  vi.useRealTimers();
});

/**
 * A tab with the document service. `noFiles`: a tab that cannot use ws.files on
 * the same folder (a P1 build, which had only ws.data).
 */
function make(opts: { ws?: FakeWorkspace; kernel?: FakeKernel; noFiles?: boolean; interval?: number; viewInterval?: number; burst?: number; units?: 'metric' | 'imperial' } = {}) {
  const ws = opts.ws ?? createFakeWorkspace({ units: opts.units });
  const kernel = opts.kernel ?? new FakeKernel();
  const bridge = createBridge(ws);
  const b = opts.noFiles ? { ...bridge, files: null } : bridge;
  const bus = createBus<CadEvents>();
  const logs: string[] = [];
  // `interval: undefined` given explicitly = the app's own 1.5 s budget.
  const saveIntervalMs = 'interval' in opts ? opts.interval : 20;
  // View-only writes: 20 ms here unless a test asks for the app's own 2 s (`viewInterval: undefined`).
  const saveViewIntervalMs = 'viewInterval' in opts ? opts.viewInterval : 20;
  const doc = createDocService({ bridge: b, kernel, bus, saveIntervalMs, saveBurst: opts.burst, saveViewIntervalMs, log: (m) => logs.push(m) });
  services.push(doc);
  return { ws, kernel, doc, bus, logs };
}

/** Wait until the rebuild after the latest change finished. */
async function rebuilt(doc: DocService) {
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state, f.name).not.toBe('pending');
    },
    { timeout: 2000, interval: 5 },
  );
  // Let a rebuild queued by the last change start and finish.
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(() => expect(doc.state.get().rebuild.status).toBe('done'), { timeout: 2000, interval: 5 });
}

async function saved(doc: DocService) {
  await vi.waitFor(() => expect(doc.state.get().save.state).toBe('saved'), { timeout: 3000, interval: 5 });
}

describe('loading and storage', () => {
  it('a new Part stores a pointer in the study record and its model beside it, in the app units', async () => {
    const { ws, doc } = make({ units: 'imperial' });
    await doc.load();
    const s = doc.state.get();
    expect(s.status).toBe('ready');
    expect(s.doc.units).toEqual({ length: 'in', angle: 'deg' });
    const record = await ws.study.get();
    expect(record.doc).toEqual({ rel: MODEL, schema: 1, store: 'data', view: VIEW });
    // Only the host's fields and the pointer: no model in the record.
    expect(Object.keys(record).sort()).toEqual(['created_at', 'doc', 'id', 'kind', 'plugin', 'plugin_name', 'plugin_version', 'rev', 'schema_version', 'title', 'updated_at']);
    const file = ws.json(MODEL) as { format: string; etag: string; doc: { units: unknown; features: unknown[] } };
    expect(file.format).toBe('magnusim-cad/model');
    expect(file.doc.units).toEqual({ length: 'in', angle: 'deg' });
    expect(file.doc.features).toEqual([]);
    // Frozen snapshots.
    expect(Object.isFrozen(s.doc)).toBe(true);
  });

  it('reopening reads the same model, and the unit preference no longer changes it', async () => {
    const { ws, doc } = make({ units: 'metric' });
    await doc.load();
    doc.beginNew('box').commit();
    await doc.flush();
    doc.dispose();
    ws.push('units', 'imperial');
    const again = make({ ws });
    await again.doc.load();
    expect(again.doc.state.get().doc.units.length).toBe('mm');
    expect(again.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1']);
    await rebuilt(again.doc);
    expect(again.doc.state.get().rebuild.bodies.map((b) => [b.name, b.volume])).toEqual([['Body 1', 8000]]);
  });

  it('a model from a newer version is an error and is never overwritten', async () => {
    const ws = createFakeWorkspace({ study: { doc: { rel: MODEL, schema: 1, store: 'data', view: VIEW } } });
    ws.folder.putJson(MODEL, { format: 'magnusim-cad/model', etag: '3.x', saved_at: '', doc: { schema: 2, units: {}, features: [] } });
    const { doc } = make({ ws });
    await doc.load();
    expect(doc.state.get()).toMatchObject({ status: 'error', error: 'Could not read the part: it was saved by a newer Magnusim CAD (schema 2); this one reads schema 1' });
    expect(doc.editable()).toMatch(/newer Magnusim CAD/);
    expect(() => doc.beginNew('box')).toThrow(/newer/);
    expect(ws.log.dataWrites.filter((w) => w.rel === MODEL)).toEqual([]);
  });
});

describe('panel sessions and edits', () => {
  it('an edit session that ends where it began makes no undo step (review round 1)', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').commit();
    const id = doc.state.get().doc.features[0].id;
    expect(doc.state.get().history.undoLabel).toBe('Box 1');
    const s = doc.beginEdit(id);
    s.update({ size: ['1e6 mm', '20 mm', '20 mm'] } as Partial<BoxFeature>);
    s.update({ size: ['20 mm', '20 mm', '20 mm'] } as Partial<BoxFeature>);
    s.commit();
    // Undo still names the box: no "Edit Box 1" step that would change nothing.
    expect(doc.state.get().history.undoLabel).toBe('Box 1');
    doc.undo();
    expect(doc.state.get().doc.features).toEqual([]);
  });

  it('a new Box applies live, Done makes one undo step, undo and redo', async () => {
    const { doc } = make();
    await doc.load();
    const s = doc.beginNew('box');
    expect(doc.state.get().session).toMatchObject({ feature: s.feature, isNew: true });
    const f = doc.state.get().doc.features[0] as BoxFeature;
    expect(f).toMatchObject({ name: 'Box 1', op: 'new', size: ['20 mm', '20 mm', '20 mm'] });
    expect(doc.state.get().doc.bodies[f.creates!]).toEqual({ name: 'Body 1', color: '#bdc9db' });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0]).toMatchObject({ name: 'Body 1', volume: 8000 });

    // A valid change applies at once; an invalid one keeps the last valid version.
    s.update({ size: ['10 mm', '20 mm', '30 mm'] } as Partial<BoxFeature>);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(6000);
    s.update({ size: ['10 mm', '20 mm', '30 +'] } as Partial<BoxFeature>);
    expect(s.incomplete()).toBe('Height: "30 +" is incomplete');
    expect((doc.state.get().doc.features[0] as BoxFeature).size[2]).toBe('30 mm');
    s.update({ size: ['10 mm', '20 mm', '40'] } as Partial<BoxFeature>);
    expect(s.incomplete()).toBeNull();

    expect(doc.state.get().history.canUndo).toBe(false);
    s.commit();
    expect(doc.state.get().session).toBeNull();
    expect(doc.state.get().history).toMatchObject({ canUndo: true, undoLabel: 'Box 1' });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(8000);

    doc.undo();
    expect(doc.state.get().doc.features).toEqual([]);
    expect(doc.state.get().doc.bodies).toEqual({});
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toEqual([]);
    expect(doc.state.get().history).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'Box 1' });
    doc.redo();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies.map((b) => b.volume)).toEqual([8000]);
  });

  it('Delete on a new feature discards it (no undo step); an edit session is "Edit Box 1"', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').discard();
    expect(doc.state.get().doc.features).toEqual([]);
    expect(doc.state.get().history.canUndo).toBe(false);
    doc.beginNew('box').commit();
    const id = doc.state.get().doc.features[0].id;
    const e = doc.beginEdit(id);
    expect(doc.beginEdit(id)).toBe(e);
    e.update({ origin: ['5', '0', '0'] } as Partial<BoxFeature>);
    e.update({ origin: ['6', '0', '0'] } as Partial<BoxFeature>);
    e.commit();
    expect(doc.state.get().history.undoLabel).toBe('Edit Box 1');
    doc.undo();
    expect((doc.state.get().doc.features[0] as BoxFeature).origin).toEqual(['0', '0', '0']);
    // Undo during a session closes it first (the session is its own step).
    const e2 = doc.beginEdit(id);
    e2.update({ origin: ['9', '0', '0'] } as Partial<BoxFeature>);
    doc.undo();
    expect(e2.open).toBe(false);
    expect((doc.state.get().doc.features[0] as BoxFeature).origin).toEqual(['0', '0', '0']);
    expect(doc.state.get().history.redoLabel).toBe('Edit Box 1');
  });

  it('switching the operation keeps the body id for the session and drops unused bodies at Done', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').commit();
    const s = doc.beginNew('cylinder');
    const made = (doc.state.get().doc.features[1] as CylinderFeature).creates!;
    s.update({ op: 'cut' } as Partial<CylinderFeature>);
    expect((doc.state.get().doc.features[1] as CylinderFeature).creates).toBeNull();
    s.update({ op: 'new' } as Partial<CylinderFeature>);
    expect((doc.state.get().doc.features[1] as CylinderFeature).creates).toBe(made);
    s.update({ op: 'cut', origin: ['10', '10', '-5'], diameter: '10', height: '40' } as Partial<CylinderFeature>);
    s.commit();
    expect(Object.keys(doc.state.get().doc.bodies)).toHaveLength(1);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[s.feature]).toMatchObject({ state: 'ok' });
    expect(doc.state.get().rebuild.bodies).toHaveLength(1);
  });

  it('rename, suppress and delete, with the dependents guard', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').commit();
    const box = doc.state.get().doc.features[0] as BoxFeature;
    const s = doc.beginNew('cylinder', { op: 'cut', creates: null, scope: [box.creates!], origin: ['10', '10', '-5'], height: '40', diameter: '10' } as Partial<CylinderFeature>);
    s.commit();
    const cylId = doc.state.get().doc.features[1].id;

    expect(doc.rename(box.id, 'Cylinder 1')).toEqual({ ok: false, reason: 'Another feature is already called Cylinder 1' });
    expect(doc.rename(box.id, '  ')).toEqual({ ok: false, reason: 'Enter a name' });
    expect(doc.rename(box.id, 'Base')).toEqual({ ok: true });
    expect(doc.state.get().history.undoLabel).toBe('Rename Box 1');

    expect(doc.remove(box.id)).toEqual({ ok: false, reason: 'Cylinder 1 uses Body 1 of Base: delete Cylinder 1 or change what it uses first' });
    expect(doc.move(cylId, 0)).toEqual({ ok: false, reason: 'Cylinder 1 uses Base: it cannot move above it' });

    expect(doc.setSuppressed(cylId, true)).toEqual({ ok: true });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[cylId]).toEqual({ state: 'suppressed', bodiesBefore: 1 });
    expect(doc.state.get().history.undoLabel).toBe('Suppress Cylinder 1');

    expect(doc.remove(cylId)).toEqual({ ok: true });
    expect(doc.remove(box.id)).toEqual({ ok: true });
    expect(doc.state.get().doc.features).toEqual([]);
    expect(doc.state.get().doc.bodies).toEqual({});
    doc.undo();
    expect(doc.state.get().doc.features.map((f) => f.name)).toEqual(['Base']);
  });

  it('bodies: rename and colour are undoable; visibility is view state (not undoable)', async () => {
    const { doc, ws } = make();
    await doc.load();
    doc.beginNew('box').commit();
    const b = (doc.state.get().doc.features[0] as BoxFeature).creates!;
    expect(doc.renameBody(b, 'Fluid')).toEqual({ ok: true });
    expect(doc.setBodyColor(b, 'red')).toEqual({ ok: false, reason: 'A colour is written #rrggbb' });
    expect(doc.setBodyColor(b, '#4884EB')).toEqual({ ok: true });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0]).toMatchObject({ name: 'Fluid', color: '#4884eb', visible: true });
    const steps = doc.state.get().history.undoLabel;
    doc.setBodyVisible(b, false);
    expect(doc.state.get().rebuild.bodies[0].visible).toBe(false);
    expect(doc.state.get().view.hiddenBodies).toEqual([b]);
    expect(doc.state.get().history.undoLabel).toBe(steps);
    await doc.flush();
    expect((ws.json(VIEW) as { view: { hiddenBodies: string[] } }).view.hiddenBodies).toEqual([b]);
  });

  it('the rollback bar stops the rebuild; new features go in at the bar', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').commit();
    doc.beginNew('box', { origin: ['50', '0', '0'] } as Partial<BoxFeature>).commit();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toHaveLength(2);
    doc.setRollback(1);
    await rebuilt(doc);
    const [f1, f2] = doc.state.get().doc.features;
    expect(doc.state.get().rebuild.features[f2.id]).toEqual({ state: 'rolled-back' });
    expect(doc.state.get().rebuild.bodies.map((b) => b.feature)).toEqual([f1.id]);
    expect(doc.state.get().history.undoLabel).toBe('Box 2');
    doc.beginNew('cylinder').commit();
    expect(doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1', 'Cylinder 1', 'Box 2']);
    expect(doc.state.get().view.rollback).toBe(2);
    doc.setRollback(null);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toHaveLength(3);
  });

  it('undo of a feature inserted at the rollback bar keeps the features below the bar rolled back; redo puts it back (review round 2)', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('box').commit();
    doc.beginNew('cylinder').commit();
    doc.setRollback(1);
    doc.beginNew('box', { origin: ['50', '0', '0'] } as Partial<BoxFeature>).commit();
    const names = () => doc.state.get().doc.features.map((f) => f.name);
    expect(names()).toEqual(['Box 1', 'Box 2', 'Cylinder 1']);
    expect(doc.state.get().view.rollback).toBe(2);
    doc.undo();
    expect(names()).toEqual(['Box 1', 'Cylinder 1']);
    // It went to the end (null) and Cylinder 1 came back.
    expect(doc.state.get().view.rollback).toBe(1);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[doc.state.get().doc.features[1].id]).toEqual({ state: 'rolled-back' });
    doc.redo();
    expect(names()).toEqual(['Box 1', 'Box 2', 'Cylinder 1']);
    expect(doc.state.get().view.rollback).toBe(2);
    // Undo of a delete above the bar: the bar stays above the same feature.
    expect(doc.remove(doc.state.get().doc.features[0].id)).toEqual({ ok: true });
    expect(names()).toEqual(['Box 2', 'Cylinder 1']);
    expect(doc.state.get().view.rollback).toBe(1);
    doc.undo();
    expect(names()).toEqual(['Box 1', 'Box 2', 'Cylinder 1']);
    expect(doc.state.get().view.rollback).toBe(2);
  });
});

describe('parameters', () => {
  it('add, rename (every use follows), cycles refused, removal guarded', async () => {
    const { doc } = make();
    await doc.load();
    const w = doc.addParam({ name: 'w', expr: '40', quantity: 'length' });
    expect(typeof w).toBe('string');
    expect(doc.addParam({ name: 'w', expr: '1', quantity: 'length' })).toEqual({ ok: false, reason: 'There is already a parameter called w' });
    expect(doc.addParam({ name: 'bad', expr: '2 deg', quantity: 'length' })).toEqual({ ok: false, reason: 'Expected a length, got an angle' });
    const h = doc.addParam({ name: 'h', expr: 'w / 2', quantity: 'length' }) as string;
    doc.beginNew('box', { size: ['w', 'h', '10'] } as Partial<BoxFeature>).commit();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(40 * 20 * 10);

    expect(doc.updateParam(w as string, { expr: 'h * 2' })).toEqual({ ok: false, reason: 'Circular reference: w → h → w' });
    expect(doc.updateParam(w as string, { name: 'width' })).toEqual({ ok: true });
    const d = doc.state.get().doc;
    expect(d.params.find((p) => p.id === h)?.expr).toBe('width / 2');
    expect((d.features[0] as BoxFeature).size).toEqual(['width', 'h', '10']);
    expect(doc.updateParam(w as string, { expr: '60' })).toEqual({ ok: true });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(60 * 30 * 10);

    expect(doc.removeParam(w as string)).toEqual({ ok: false, reason: "width can't be deleted: h and Box 1 use it" });
    doc.undo();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(40 * 20 * 10);
  });
});

describe('autosave and conflicts', () => {
  it('a change is written at once; changes made while a write runs go right after it, together', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { doc, ws } = make({ interval: undefined });
    await doc.load();
    const writes = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const first = writes();
    const s = doc.beginNew('box');
    // Written at once (no timer a closing page would never fire).
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 1);
    expect(doc.state.get().save.state).toBe('saved');
    // Two changes in the same moment: the first starts a write, the second waits for it and follows at once.
    s.update({ size: ['11', '10', '10'] } as Partial<BoxFeature>);
    s.update({ size: ['12', '10', '10'] } as Partial<BoxFeature>);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 3);
    s.commit();
    const stored = ws.json(MODEL) as { doc: { features: BoxFeature[] } };
    expect(stored.doc.features[0].size[0]).toBe('12');
    expect(doc.state.get().save.state).toBe('saved');
  });

  it('after a burst of quick writes the budget spaces them 1.5 s apart (gate 10); leaving the frame writes at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    expect(SAVE_BURST).toBe(6);
    const { doc, ws } = make({ interval: undefined, burst: 4 });
    await doc.load(); // the new Part's own write uses one of the burst
    const writes = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const first = writes();
    const id = () => doc.state.get().doc.features[0]?.id;
    doc.beginNew('box').commit();
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(10);
      doc.rename(id()!, `Block ${i}`);
    }
    await vi.advanceTimersByTimeAsync(10);
    // Burst of 4 used: the new Part, the box, Block 1, Block 2. Block 3 waits for the budget.
    expect(writes()).toBe(first + 3);
    expect(doc.state.get().save.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1400);
    expect(writes()).toBe(first + 3);
    await vi.advanceTimersByTimeAsync(200);
    expect(writes()).toBe(first + 4);
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features[0].name).toBe('Block 3');
    // Throttled again; the pointer leaving the frame (Back, Settings, the browser) writes it now.
    doc.rename(id()!, 'Block 4');
    await vi.advanceTimersByTimeAsync(10);
    expect(writes()).toBe(first + 4);
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 5);
    // The frame losing focus, and F5 / Ctrl+R / Ctrl+W pressed in it, do the same.
    doc.rename(id()!, 'Block 5');
    window.dispatchEvent(new FocusEvent('blur'));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 6);
    doc.rename(id()!, 'Block 6');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 7);
    doc.rename(id()!, 'Block 7');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 8);
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features[0].name).toBe('Block 7');
    expect(doc.state.get().save.state).toBe('saved');
    // Other keys do not.
    doc.rename(id()!, 'Block 8');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 8);
    await vi.advanceTimersByTimeAsync(1600);
    expect(writes()).toBe(first + 9);
  });

  it('undo, redo, undo in quick succession ends on Saved, not Saving (review round 1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { doc, ws } = make({ interval: undefined, burst: 1 });
    await doc.load();
    doc.beginNew('box').commit();
    await vi.advanceTimersByTimeAsync(3500); // the box is written after 1.5 s; the budget refills 1.5 s later
    expect(doc.state.get().save.state).toBe('saved');
    const writes = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const first = writes();
    doc.undo(); // written at once (the budget has refilled)
    await vi.advanceTimersByTimeAsync(5);
    expect(writes()).toBe(first + 1);
    doc.redo(); // within the budget's 1.5 s: waits
    await vi.advanceTimersByTimeAsync(5);
    expect(doc.state.get().save.state).toBe('pending');
    doc.undo(); // back to what is stored: nothing to write, and the chip says so
    expect(doc.state.get().save.state).toBe('saved');
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes()).toBe(first + 1);
    expect(doc.state.get().save.state).toBe('saved');
    expect((ws.json(MODEL) as { doc: { features: unknown[] } }).doc.features).toHaveLength(0);
  });

  it('a reopened Part says Saved, with the time it was stored', async () => {
    const ws = createFakeWorkspace();
    const a = make({ ws });
    await a.doc.load();
    a.doc.beginNew('box').commit();
    await a.doc.flush();
    const at = (ws.json(MODEL) as { saved_at: string }).saved_at;
    a.doc.dispose();
    const b = make({ ws });
    await b.doc.load();
    expect(b.doc.state.get().save).toEqual({ state: 'saved', at });
  });

  it('a save refused because another tab wrote shows the conflict; Reload adopts theirs', async () => {
    const ws = createFakeWorkspace();
    const a = make({ ws });
    await a.doc.load();
    const b = make({ ws });
    await b.doc.load();
    a.doc.beginNew('box').commit();
    await a.doc.flush();
    await saved(a.doc);
    // Tab B had not seen A's box: its next save is refused.
    b.doc.beginNew('cylinder').commit();
    await b.doc.flush();
    expect(b.doc.state.get().save).toEqual({ state: 'conflict', message: 'Changed in another tab' });
    expect(b.doc.editable()).toBe('Changed in another tab · Reload to keep editing');
    expect(b.doc.rename(b.doc.state.get().doc.features[0].id, 'x')).toEqual({ ok: false, reason: 'Changed in another tab · Reload to keep editing' });
    // A's model is intact.
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name)).toEqual(['Box 1']);
    await b.doc.reload();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(b.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1']);
    expect(b.doc.editable()).toBe(true);
  });

  it('a rename in the host header is adopted silently (no conflict)', async () => {
    const { ws, doc } = make();
    await doc.load();
    const rec = await ws.study.get();
    await ws.study.update({ title: 'Renamed' }, rec.rev);
    doc.beginNew('box').commit();
    await doc.flush();
    expect(doc.state.get().save.state).toBe('saved');
    expect((doc as unknown as { studyRev: number }).studyRev).toBe(rec.rev + 1);
  });

  it('pagehide posts the pending model at once (the host removes the frame on Back)', async () => {
    const { ws, doc } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    // The budget is used by the new Part's first write: the change waits.
    doc.beginNew('box').commit();
    expect(doc.state.get().save.state).toBe('pending');
    window.dispatchEvent(new Event('pagehide'));
    // Posted before the event returned.
    expect((ws.json(MODEL) as { doc: { features: unknown[] } }).doc.features).toHaveLength(1);
    await saved(doc);
  });

  it('view-only changes never spend the model budget; they are written one per 2 s, the first at once (review round 2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { doc, ws } = make({ interval: undefined, viewInterval: undefined });
    await doc.load(); // the new Part: 1 of the 6
    doc.beginNew('box').commit(); // 2 of the 6
    await vi.advanceTimersByTimeAsync(10);
    const models = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const views = () => ws.log.dataWrites.filter((w) => w.rel === VIEW).length;
    const m0 = models();
    const v0 = views();
    // A person opens and closes a tree folder: ten clicks, 150 ms apart.
    for (let i = 0; i < 10; i++) {
      doc.setExpanded('origin', i % 2 === 0);
      await vi.advanceTimersByTimeAsync(150);
    }
    // The first at once, then at most one per 2 s (1.5 s have passed): 1 so far.
    expect(views()).toBe(v0 + 1);
    expect(models()).toBe(m0);
    // The model's budget is untouched: four edits in a row are each written at once.
    const id = doc.state.get().doc.features[0].id;
    for (let i = 1; i <= 4; i++) {
      doc.rename(id, `Block ${i}`);
      await vi.advanceTimersByTimeAsync(5);
      expect(models()).toBe(m0 + i);
      expect(doc.state.get().save.state).toBe('saved');
    }
    // The waiting view went along with the first of them (the last folder state).
    expect(views()).toBe(v0 + 2);
    expect((ws.json(VIEW) as { view: { expanded: string[] } }).view.expanded).not.toContain('origin');
    // A view change alone waits for its 2 s, then is written; it never waits on the model.
    doc.setExpanded('bodies', true);
    await vi.advanceTimersByTimeAsync(5);
    expect(views()).toBe(v0 + 2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(views()).toBe(v0 + 3);
    expect(models()).toBe(m0 + 4);
  });

  it('F5, Ctrl+W, the mouse side buttons and hiding post a waiting model in one message, before the event returns (review round 2)', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load(); // the budget's only write
    const reads = vi.spyOn(ws.data, 'read');
    const stored = () => (ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name);
    doc.beginNew('box').commit();
    expect(doc.state.get().save.state).toBe('pending');
    const before = reads.mock.calls.length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    // In the store before the key event returned, with no read first (a reload does not wait for a second round trip).
    expect(stored()).toEqual(['Box 1']);
    expect(reads.mock.calls.length).toBe(before);
    expect(doc.state.get().save.state).toBe('saving');
    await saved(doc);
    const hide = () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    };
    const id = doc.state.get().doc.features[0].id;
    const cases: [string, () => void][] = [
      // The mouse's Back (3) and Forward (4) buttons: the press is the signal.
      ['Back button', () => window.dispatchEvent(new MouseEvent('mousedown', { button: 3 }))],
      ['Forward button', () => window.dispatchEvent(new MouseEvent('mouseup', { button: 4 }))],
      ['Ctrl+W', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))],
      ['Hidden', hide],
    ];
    for (const [what, fire] of cases) {
      doc.rename(id, what);
      expect(doc.state.get().save.state, what).toBe('pending');
      fire();
      expect(stored(), what).toEqual([what]);
      await saved(doc);
    }
    // Other buttons do not.
    doc.rename(id, 'Left click');
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    expect(stored()).toEqual(['Hidden']);
    // The next usual (conditional) save goes on top of it: no false conflict.
    await doc.flush();
    expect(doc.state.get().save.state).toBe('saved');
    expect(stored()).toEqual(['Left click']);
  });

  it('a save on leaving overtakes a save that is still reading: the newer model is stored, not the older', async () => {
    const { doc, ws } = make({ interval: 60_000, burst: 6 });
    await doc.load();
    const realRead = ws.data.read.bind(ws.data);
    let release: (() => void) | null = null;
    vi.spyOn(ws.data, 'read').mockImplementation(async (rel: string) => {
      if (rel === MODEL) await new Promise<void>((r) => (release = r));
      return realRead(rel);
    });
    const names = (file: unknown) => (file as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name);
    const first = ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    doc.beginNew('box').commit(); // a usual save starts: its read hangs
    await vi.waitFor(() => expect(release).not.toBeNull());
    const id = doc.state.get().doc.features[0].id;
    doc.rename(id, 'Newer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    expect(names(ws.json(MODEL))).toEqual(['Newer']);
    (release as unknown as () => void)();
    await saved(doc);
    // The overtaken save did not write its older model after it.
    expect(names(ws.json(MODEL))).toEqual(['Newer']);
    expect(ws.log.dataWrites.filter((w) => w.rel === MODEL).slice(first).map((w) => names(w.doc).join())).toEqual(['Newer']);
  });

  it('leaving uses the usual read-then-write save when this tab has not read the stored version for 10 s (another tab may have saved)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { doc, ws } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    await vi.advanceTimersByTimeAsync(11_000);
    const reads = vi.spyOn(ws.data, 'read');
    doc.beginNew('box').commit();
    expect(doc.state.get().save.state).toBe('pending');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    expect(reads).toHaveBeenCalledWith(MODEL);
    await vi.advanceTimersByTimeAsync(0);
    expect(doc.state.get().save.state).toBe('saved');
  });

  it('a save on leaving keeps the other tab honest: its next save says "Changed in another tab"', async () => {
    const ws = createFakeWorkspace();
    const a = make({ ws, interval: 60_000, burst: 2 });
    await a.doc.load();
    const b = make({ ws, interval: 60_000, burst: 6 });
    await b.doc.load();
    // A's second change waits on its budget; then A reloads (F5).
    a.doc.beginNew('box').commit();
    a.doc.beginNew('box').commit();
    expect(a.doc.state.get().save.state).toBe('pending');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await saved(a.doc);
    // B had not seen A's boxes: its save is refused, and A's model stays.
    b.doc.beginNew('cylinder').commit();
    await b.doc.flush();
    expect(b.doc.state.get().save.state).toBe('conflict');
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name)).toEqual(['Box 1', 'Box 2']);
  });
});

describe('ws.files (host API 1.2)', () => {
  const host12 = () => createFakeWorkspace({ hostVersion: '1.2' });
  const featureNames = (file: unknown) => (file as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name);

  it('a new Part is created with ifMatch null, then every save goes on the etag of the last write; the view goes through ws.data', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    expect((await ws.study.get()).doc).toEqual({ rel: MODEL, schema: 1, store: 'files', view: VIEW });
    expect(ws.files.writes).toEqual([{ rel: MODEL, ifMatch: null }]);
    const first = ws.folder.info(MODEL)!.etag;
    a.doc.beginNew('box').commit();
    await a.doc.flush();
    expect(ws.files.writes.at(-1)).toEqual({ rel: MODEL, ifMatch: first });
    const second = ws.folder.info(MODEL)!.etag;
    a.doc.rename(a.doc.state.get().doc.features[0].id, 'Block');
    await a.doc.flush();
    expect(ws.files.writes.at(-1)).toEqual({ rel: MODEL, ifMatch: second });
    // A file written through ws.files carries no version token of its own: the host's etag is its version.
    const file = ws.json(MODEL) as { format: string; etag?: string; doc: unknown };
    expect(file.format).toBe('magnusim-cad/model');
    expect(file.etag).toBeUndefined();
    expect(featureNames(file)).toEqual(['Block']);
    // The model never goes through ws.data; the view (folders, eyes, the bar) does.
    a.doc.setExpanded('bodies', true);
    await a.doc.flush();
    expect(ws.log.dataWrites.map((w) => w.rel)).toEqual([VIEW]);
    expect(ws.files.writes.every((w) => w.rel === MODEL)).toBe(true);
  });

  it('another tab saved first: the write is refused on its etag ("changed"), the chip says so, and Reload adopts theirs', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    const b = make({ ws });
    await b.doc.load();
    a.doc.beginNew('box').commit();
    await a.doc.flush();
    expect(a.doc.state.get().save.state).toBe('saved');
    b.doc.beginNew('cylinder').commit();
    await b.doc.flush();
    expect(b.doc.state.get().save).toEqual({ state: 'conflict', message: 'Changed in another tab' });
    expect(featureNames(ws.json(MODEL))).toEqual(['Box 1']);
    await b.doc.reload();
    expect(b.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1']);
    expect(b.doc.state.get().save.state).toBe('saved');
    b.doc.beginNew('cylinder').commit();
    await b.doc.flush();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(featureNames(ws.json(MODEL))).toEqual(['Box 1', 'Cylinder 1']);
  });

  it('a P1 Part (kept with ws.data) moves to ws.files once: the P1 file is kept byte for byte, the model is written on the etag it was read at', async () => {
    const ws = host12();
    const p1 = make({ ws, noFiles: true });
    await p1.doc.load();
    p1.doc.beginNew('box').commit();
    await p1.doc.flush();
    expect((await ws.study.get()).doc).toMatchObject({ store: 'data' });
    const before = ws.folder.entries.get(MODEL)!;
    const p1Bytes = new TextDecoder().decode(before.bytes);
    expect((ws.json(MODEL) as { etag: string }).etag).toMatch(/^\d+\./);
    p1.doc.dispose();

    const now = make({ ws });
    await now.doc.load();
    expect((await ws.study.get()).doc).toEqual({ rel: MODEL, schema: 1, store: 'files', view: VIEW });
    expect(now.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1']);
    // Kept as it was (never deleted), then the model written through ws.files on the version read.
    expect(new TextDecoder().decode(ws.folder.entries.get('studies/st-test/model.p1.json')!.bytes)).toBe(p1Bytes);
    expect(ws.files.writes).toEqual([
      { rel: 'studies/st-test/model.p1.json', ifMatch: null },
      { rel: MODEL, ifMatch: before.etag },
    ]);
    expect((ws.json(MODEL) as { etag?: string }).etag).toBeUndefined();
    now.doc.beginNew('cylinder').commit();
    await now.doc.flush();
    expect(featureNames(ws.json(MODEL))).toEqual(['Box 1', 'Cylinder 1']);
    now.doc.dispose();

    // Opened again: nothing moves a second time.
    const writes = ws.files.writes.length;
    const again = make({ ws });
    await again.doc.load();
    expect(ws.files.writes.length).toBe(writes);
    expect(again.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Box 1', 'Cylinder 1']);
  });

  it('a tab still on ws.data when the model moved gets "Changed in another tab", not a silent overwrite', async () => {
    const ws = host12();
    const old = make({ ws, noFiles: true });
    await old.doc.load();
    old.doc.beginNew('box').commit();
    await old.doc.flush();
    const next = make({ ws });
    await next.doc.load();
    expect((await ws.study.get()).doc).toMatchObject({ store: 'files' });
    old.doc.beginNew('cylinder').commit();
    await old.doc.flush();
    expect(old.doc.state.get().save.state).toBe('conflict');
    expect(featureNames(ws.json(MODEL))).toEqual(['Box 1']);
  });

  it('a host that refuses ws.files ("not_allowed") keeps ws.data; a 1.1 host never calls them', async () => {
    const ws = host12();
    ws.files.refuse = 'not_allowed';
    const { doc } = make({ ws });
    await doc.load();
    expect((await ws.study.get()).doc).toMatchObject({ store: 'data' });
    expect(ws.folder.has(MODEL)).toBe(true);
    const old = createFakeWorkspace({ hostVersion: '1.1' });
    const t = make({ ws: old });
    await t.doc.load();
    expect((await old.study.get()).doc).toMatchObject({ store: 'data' });
    expect(old.files.writes).toEqual([]);
    expect(old.log.dirty).toEqual([]);
  });

  it('a refused save says why in plain words ("Not saved: the disk is full"), is retried, and Retry writes at once', async () => {
    const ws = host12();
    const { doc } = make({ ws });
    await doc.load();
    const cases: [string, string, string][] = [
      ['disk_full', 'there is not enough free disk space for this file', 'the disk is full'],
      ['quota', "this plugin's files may take 4096 MB in a project", "Magnusim CAD's files in this project are full (this plugin's files may take 4096 MB in a project)"],
      ['too_large', 'a file may be 512 MB at most', 'the part is too large to save (a file may be 512 MB at most)'],
      ['plugin_off', 'this plugin is not on', 'Magnusim CAD was turned off'],
      ['busy', 'studies/st-test/model.json is in use by another program', "another program has the part's file open"],
      ['invalid_path', "not a path in the plugin's folder: x", "the part's file name was refused"],
    ];
    doc.beginNew('box').commit();
    await saved(doc);
    const id = doc.state.get().doc.features[0].id;
    let n = 0;
    for (const [code, message, plain] of cases) {
      ws.files.failNext.push({ code, message });
      doc.rename(id, `Block ${++n}`);
      await vi.waitFor(() => expect(doc.state.get().save).toEqual({ state: 'error', message: plain }));
      expect(doc.editable()).toBe(true);
      // Retry: written now, not after the retry timer.
      doc.retrySave();
      await saved(doc);
      expect(featureNames(ws.json(MODEL))).toEqual([`Block ${n}`]);
    }
  });

  it('nav.setDirty: dirty with a plain message from the first unsaved change until it is written; a refused save stays dirty', async () => {
    const ws = host12();
    const { doc } = make({ ws });
    await doc.load();
    await saved(doc);
    ws.log.dirty.length = 0;
    let release!: () => void;
    ws.files.hold = new Promise<void>((r) => (release = r));
    const writes = ws.files.writes.length;
    doc.beginNew('box').commit();
    // A write is on its way (held), and the commit's change waits behind it.
    await vi.waitFor(() => expect(ws.files.writes.length).toBe(writes + 1));
    expect(['pending', 'saving']).toContain(doc.state.get().save.state);
    expect(ws.log.dirty).toEqual([{ dirty: true, message: 'Changes to Part 1 are not saved yet.' }]);
    ws.files.hold = null;
    release();
    await saved(doc);
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: false, message: '' });
    // Renamed in the host header: the message follows.
    const rec = await ws.study.get();
    await ws.study.update({ title: 'Housing' }, rec.rev);
    ws.files.failNext.push({ code: 'disk_full', message: 'the disk is full' });
    doc.rename(doc.state.get().doc.features[0].id, 'Block');
    await vi.waitFor(() => expect(doc.state.get().save.state).toBe('error'));
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: true, message: 'Changes to Housing are not saved: the disk is full.' });
    doc.retrySave();
    await saved(doc);
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: false, message: '' });
    // Each change of state is told once.
    expect(ws.log.dirty.map((d) => d.dirty)).toEqual([true, false, true, true, true, false]);
  });

  it('leaving (F5, the side buttons, hidden) writes with ifMatch: on a 1.2 host there is no write without the check', async () => {
    const ws = host12();
    const { doc } = make({ ws, interval: 60_000, burst: 1 });
    await doc.load();
    doc.beginNew('box').commit();
    expect(doc.state.get().save.state).toBe('pending');
    const etag = ws.folder.info(MODEL)!.etag;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await saved(doc);
    expect(ws.files.writes.at(-1)).toEqual({ rel: MODEL, ifMatch: etag });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 3 }));
    doc.rename(doc.state.get().doc.features[0].id, 'Block');
    const etag2 = ws.folder.info(MODEL)!.etag;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as unknown as { visibilityState?: string }).visibilityState;
    await saved(doc);
    expect(ws.files.writes.at(-1)).toEqual({ rel: MODEL, ifMatch: etag2 });
    expect(ws.files.writes.every((w) => w.ifMatch !== undefined)).toBe(true);
  });
});

describe('commands', () => {
  it('undo and redo commands say why they are unavailable', async () => {
    const { install } = await import('../../src/doc');
    const { createCommandRegistry } = await import('../../src/app/commands');
    const { createKeyboard } = await import('../../src/app/keyboard');
    const { doc, kernel, bus } = make();
    // eslint-disable-next-line prefer-const
    let services: Parameters<typeof install>[0];
    const commands = createCommandRegistry(() => services);
    const keyboard = createKeyboard(document);
    services = { doc, kernel, bus, commands, keyboard } as unknown as Parameters<typeof install>[0];
    const off = install(services);
    expect(await commands.run('edit.undo')).toBe('The part is still loading');
    await doc.load();
    expect(await commands.run('edit.undo')).toBe('Nothing to undo');
    doc.beginNew('box').commit();
    expect(await commands.run('edit.undo')).toBe(true);
    expect(doc.state.get().doc.features).toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
    await vi.waitFor(() => expect(doc.state.get().doc.features).toHaveLength(1));
    off();
    keyboard.dispose();
  });
});
