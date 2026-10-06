// The document service over a fake host and a fake kernel: storage outside
// the study record, panel sessions (live apply, one undo step), edits and
// their guards, parameters, undo/redo, autosave, conflicts, view state, G1.
// Solids are made as the app makes them (decision 2026-10-01, no Box or
// Cylinder): a sketch on Top, then an Extrude (tests/doc/blocks.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocService } from '../../src/doc';
import { SAVE_BURST } from '../../src/doc/autosave';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import { commitPendingEdits, pendingEditsChanged, registerPendingEdit } from '../../src/lib/pendingEdits';
import type { ExtrudeFeature, Feature, SketchFeature } from '../../src/types/doc';
import type { DocService } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import { createFakeWorkspace, type FakeWorkspace } from '../fakes/workspace-sdk';
import { block, BlockKernel, blockSketch, circleSketch, cylinder, profileOf, registerSolidFeatures } from './blocks';

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
function make(opts: { ws?: FakeWorkspace; kernel?: BlockKernel; noFiles?: boolean; interval?: number; viewInterval?: number; burst?: number; units?: 'metric' | 'imperial' } = {}) {
  const ws = opts.ws ?? createFakeWorkspace({ units: opts.units });
  const kernel = opts.kernel ?? new BlockKernel();
  const bridge = createBridge(ws);
  const b = opts.noFiles ? { ...bridge, files: null } : bridge;
  const bus = createBus<CadEvents>();
  const logs: string[] = [];
  // `interval: undefined` given explicitly = the app's own 1.5 s budget.
  const saveIntervalMs = 'interval' in opts ? opts.interval : 20;
  // View-only writes: 20 ms here unless a test asks for the app's own 2 s (`viewInterval: undefined`).
  const saveViewIntervalMs = 'viewInterval' in opts ? opts.viewInterval : 20;
  const doc = createDocService({ bridge: b, kernel, bus, saveIntervalMs, saveBurst: opts.burst, saveViewIntervalMs, log: (m) => logs.push(m) });
  registerSolidFeatures(doc);
  services.push(doc);
  return { ws, kernel, doc, bus, logs };
}

/** One model change that adds one feature: a sketch (the `n`th, side by side). */
function sketch(doc: DocService, n = 0) {
  doc.beginNew('sketch', (n % 2 ? circleSketch(30 * n, 0, 10) : blockSketch(30 * n, 0)) as Partial<Feature>).commit();
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

const names = (doc: DocService) => doc.state.get().doc.features.map((f) => f.name);
const extrudeOf = (doc: DocService, id: string) => doc.state.get().doc.features.find((f) => f.id === id) as ExtrudeFeature;
const blind = (distance: string) => ({ extent: { kind: 'blind', distance } }) as Partial<Feature>;

describe('loading and storage', () => {
  it('a new Part stores a pointer in the study record and its model beside it, in the app units', async () => {
    const { ws, doc } = make({ units: 'imperial' });
    await doc.load();
    const s = doc.state.get();
    expect(s.status).toBe('ready');
    expect(s.doc.units).toEqual({ length: 'in', angle: 'deg' });
    const record = await ws.study.get();
    expect(record.doc).toEqual({ rel: MODEL, schema: 1, store: 'data', view: VIEW });
    // Only the host's fields and the pointer: no model in the record (and no source_version
    // while nothing links a geometry: LINK, src/doc/source-record.ts).
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
    block(doc);
    await doc.flush();
    doc.dispose();
    ws.push('units', 'imperial');
    const again = make({ ws });
    await again.doc.load();
    expect(again.doc.state.get().doc.units.length).toBe('mm');
    expect(names(again.doc)).toEqual(['Sketch 1', 'Extrude 1']);
    await rebuilt(again.doc);
    expect(again.doc.state.get().rebuild.bodies.map((b) => [b.name, b.volume])).toEqual([['Body 1', 8000]]);
  });

  it('a model from a newer version is an error and is never overwritten', async () => {
    const ws = createFakeWorkspace({ study: { doc: { rel: MODEL, schema: 1, store: 'data', view: VIEW } } });
    ws.folder.putJson(MODEL, { format: 'magnusim-cad/model', etag: '3.x', saved_at: '', doc: { schema: 3, units: {}, features: [] } });
    const { doc } = make({ ws });
    await doc.load();
    expect(doc.state.get()).toMatchObject({ status: 'error', error: 'Could not read the part: it was saved by a newer Magnusim CAD (schema 3); this one reads schema 2' });
    expect(doc.editable()).toMatch(/newer Magnusim CAD/);
    expect(() => doc.beginNew('sketch')).toThrow(/newer/);
    expect(ws.log.dataWrites.filter((w) => w.rel === MODEL)).toEqual([]);
  });
});

describe('panel sessions and edits', () => {
  it('an edit session that ends where it began makes no undo step (review round 1)', async () => {
    const { doc } = make();
    await doc.load();
    const { extrude } = block(doc);
    expect(doc.state.get().history.undoLabel).toBe('Extrude 1');
    const s = doc.beginEdit(extrude);
    s.update(blind('1e6 mm'));
    s.update(blind('20 mm'));
    s.commit();
    // Undo still names the extrude: no "Edit Extrude 1" step that would change nothing.
    expect(doc.state.get().history.undoLabel).toBe('Extrude 1');
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1']);
  });

  it('a new Extrude applies live, Done makes one undo step, undo and redo', async () => {
    const { doc } = make();
    await doc.load();
    const sk = doc.beginNew('sketch', blockSketch() as Partial<Feature>);
    sk.commit();
    const s = doc.beginNew('extrude', { profiles: [profileOf(sk.feature, blockSketch())] } as Partial<Feature>);
    expect(doc.state.get().session).toMatchObject({ feature: s.feature, isNew: true });
    const f = doc.state.get().doc.features[1] as ExtrudeFeature;
    expect(f).toMatchObject({ name: 'Extrude 1', op: 'new', extent: { kind: 'blind', distance: '10 mm' } });
    expect(doc.state.get().doc.bodies[f.creates!]).toEqual({ name: 'Body 1', color: '#bdc9db' });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0]).toMatchObject({ name: 'Body 1', volume: 4000 });

    // A valid change applies at once; an invalid one keeps the last valid version.
    s.update(blind('30 mm'));
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(12000);
    s.update(blind('30 +'));
    expect(s.incomplete()).toBe('Distance: "30 +" is incomplete');
    expect((extrudeOf(doc, s.feature).extent as { distance: string }).distance).toBe('30 mm');
    s.update(blind('40'));
    expect(s.incomplete()).toBeNull();

    // Before Done only the sketch is a step.
    expect(doc.state.get().history.undoLabel).toBe('Sketch 1');
    s.commit();
    expect(doc.state.get().session).toBeNull();
    expect(doc.state.get().history).toMatchObject({ canUndo: true, undoLabel: 'Extrude 1' });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(16000);

    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1']);
    expect(doc.state.get().doc.bodies).toEqual({});
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toEqual([]);
    expect(doc.state.get().history).toMatchObject({ canUndo: true, canRedo: true, redoLabel: 'Extrude 1' });
    doc.redo();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies.map((b) => b.volume)).toEqual([16000]);
  });

  it('Delete on a new feature discards it (no undo step); an edit session is "Edit Extrude 1"', async () => {
    const { doc } = make();
    await doc.load();
    doc.beginNew('sketch', blockSketch() as Partial<Feature>).discard();
    expect(doc.state.get().doc.features).toEqual([]);
    expect(doc.state.get().history.canUndo).toBe(false);
    const { extrude: id } = block(doc);
    const e = doc.beginEdit(id);
    expect(doc.beginEdit(id)).toBe(e);
    e.update(blind('5 mm'));
    e.update(blind('6 mm'));
    e.commit();
    expect(doc.state.get().history.undoLabel).toBe('Edit Extrude 1');
    doc.undo();
    expect(extrudeOf(doc, id).extent).toEqual({ kind: 'blind', distance: '20 mm' });
    // Undo during a session closes it first (the session is its own step).
    const e2 = doc.beginEdit(id);
    e2.update(blind('9 mm'));
    doc.undo();
    expect(e2.open).toBe(false);
    expect(extrudeOf(doc, id).extent).toEqual({ kind: 'blind', distance: '20 mm' });
    expect(doc.state.get().history.redoLabel).toBe('Edit Extrude 1');
  });

  it('switching the operation keeps the body id for the session and drops unused bodies at Done', async () => {
    const { doc } = make();
    await doc.load();
    block(doc);
    const { session: s, extrude } = cylinder(doc, { open: true });
    const made = extrudeOf(doc, extrude).creates!;
    s!.update({ op: 'cut' } as Partial<Feature>);
    expect(extrudeOf(doc, extrude).creates).toBeNull();
    s!.update({ op: 'new' } as Partial<Feature>);
    expect(extrudeOf(doc, extrude).creates).toBe(made);
    s!.update({ op: 'cut', extent: { kind: 'two', distance: '35 mm', distance2: '5 mm' } } as Partial<Feature>);
    s!.commit();
    expect(Object.keys(doc.state.get().doc.bodies)).toHaveLength(1);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[extrude]).toMatchObject({ state: 'ok' });
    expect(doc.state.get().rebuild.bodies).toHaveLength(1);
  });

  it('rename, suppress and delete, with the dependents guard', async () => {
    const { doc } = make();
    await doc.load();
    const box = block(doc);
    const cut = cylinder(doc, { op: 'cut', scope: [box.body!], at: [10, 10, -5], size: [10, 40] }).extrude;

    expect(doc.rename(box.extrude, 'Extrude 2')).toEqual({ ok: false, reason: 'Another feature is already called Extrude 2' });
    expect(doc.rename(box.extrude, '  ')).toEqual({ ok: false, reason: 'Enter a name' });
    expect(doc.rename(box.extrude, 'Base')).toEqual({ ok: true });
    expect(doc.state.get().history.undoLabel).toBe('Rename Extrude 1');

    const uses = 'Extrude 2 uses Body 1 of Base: delete Extrude 2 or change what it uses first';
    expect(doc.remove(box.extrude)).toEqual({ ok: false, reason: uses });
    expect(doc.removeBlock(box.extrude)).toBe(uses);
    expect(doc.removeBlock(cut)).toBeNull();
    // The sketch an extrude uses cannot go either.
    expect(doc.removeBlock(box.sketch)).toMatch(/^Base uses Sketch 1/);
    // Review P2/P3 round 1: a refused delete of the feature a panel edits keeps that panel's work.
    const open = doc.beginEdit(box.extrude);
    open.update(blind('30 mm'));
    expect(doc.remove(box.extrude)).toEqual({ ok: false, reason: uses });
    expect(open.open).toBe(true);
    expect(extrudeOf(doc, box.extrude).extent).toEqual({ kind: 'blind', distance: '30 mm' });
    open.discard();
    expect(doc.move(cut, 1)).toEqual({ ok: false, reason: 'Extrude 2 uses Sketch 2: it cannot move above it' });
    expect(doc.move(box.extrude, 3)).toEqual({ ok: false, reason: 'Extrude 2 uses Base: Base cannot move below it' });

    expect(doc.setSuppressed(cut, true)).toEqual({ ok: true });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[cut]).toEqual({ state: 'suppressed', bodiesBefore: 1 });
    expect(doc.state.get().history.undoLabel).toBe('Suppress Extrude 2');

    expect(doc.remove(cut)).toEqual({ ok: true });
    expect(doc.remove(box.extrude)).toEqual({ ok: true });
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 2']);
    expect(doc.state.get().doc.bodies).toEqual({});
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1', 'Base', 'Sketch 2']);
  });

  it('bodies: rename and colour are undoable; visibility is view state (not undoable)', async () => {
    const { doc, ws } = make();
    await doc.load();
    const b = block(doc).body!;
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
    const one = block(doc);
    const two = block(doc, { at: [50, 0, 0] });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toHaveLength(2);
    doc.setRollback(2);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[two.sketch]).toEqual({ state: 'rolled-back' });
    expect(doc.state.get().rebuild.features[two.extrude]).toEqual({ state: 'rolled-back' });
    expect(doc.state.get().rebuild.bodies.map((b) => b.feature)).toEqual([one.extrude]);
    expect(doc.state.get().history.undoLabel).toBe('Extrude 2');
    cylinder(doc, { at: [0, 50, 0] });
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(4);
    doc.setRollback(null);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies).toHaveLength(3);
  });

  it('undo of a feature inserted at the rollback bar keeps the features below the bar rolled back; redo puts it back (review round 2)', async () => {
    const { doc } = make();
    await doc.load();
    block(doc);
    const cyl = cylinder(doc, { at: [50, 0, 0] });
    doc.setRollback(2);
    block(doc, { at: [0, 50, 0] });
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(4);
    // Undo takes back Extrude 3, then Sketch 3: the bar stays above Sketch 2 (it did not jump to the end).
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(3);
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(2);
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features[cyl.sketch]).toEqual({ state: 'rolled-back' });
    expect(doc.state.get().rebuild.features[cyl.extrude]).toEqual({ state: 'rolled-back' });
    doc.redo();
    doc.redo();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(4);
    // Undo of a delete above the bar: the bar stays above the same feature.
    const e1 = doc.state.get().doc.features[1].id;
    expect(doc.remove(e1)).toEqual({ ok: true });
    expect(names(doc)).toEqual(['Sketch 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(3);
    doc.undo();
    expect(names(doc)).toEqual(['Sketch 1', 'Extrude 1', 'Sketch 3', 'Extrude 3', 'Sketch 2', 'Extrude 2']);
    expect(doc.state.get().view.rollback).toBe(4);
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
    // A 10 x 20 profile extruded w along +Z and h against it: 10 x 20 x (w + h).
    const { extrude } = block(doc, { size: [10, 20, 1], extrude: { extent: { kind: 'two', distance: 'w', distance2: 'h' } } });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(10 * 20 * 60);

    expect(doc.updateParam(w as string, { expr: 'h * 2' })).toEqual({ ok: false, reason: 'Circular reference: w → h → w' });
    expect(doc.updateParam(w as string, { name: 'width' })).toEqual({ ok: true });
    const d = doc.state.get().doc;
    expect(d.params.find((p) => p.id === h)?.expr).toBe('width / 2');
    expect(extrudeOf(doc, extrude).extent).toEqual({ kind: 'two', distance: 'width', distance2: 'h' });
    expect(doc.updateParam(w as string, { expr: '60' })).toEqual({ ok: true });
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(10 * 20 * 90);

    expect(doc.removeParam(w as string)).toEqual({ ok: false, reason: "width can't be deleted: h and Extrude 1 use it" });
    doc.undo();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies[0].volume).toBe(10 * 20 * 60);
  });
});

describe('autosave and conflicts', () => {
  it('a change is written at once; changes made while a write runs go right after it, together', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { doc, ws } = make({ interval: undefined });
    await doc.load();
    const writes = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const first = writes();
    const s = doc.beginNew('sketch', blockSketch() as Partial<Feature>);
    // Written at once (no timer a closing page would never fire).
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 1);
    expect(doc.state.get().save.state).toBe('saved');
    // Two changes in the same moment: the first starts a write, the second waits for it and follows at once.
    s.update({ points: { ...blockSketch().points, pt_2: [11, 0] } } as Partial<Feature>);
    s.update({ points: { ...blockSketch().points, pt_2: [12, 0] } } as Partial<Feature>);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes()).toBe(first + 3);
    s.commit();
    const stored = ws.json(MODEL) as { doc: { features: SketchFeature[] } };
    expect(stored.doc.features[0].points.pt_2[0]).toBe(12);
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
    sketch(doc);
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(10);
      doc.rename(id()!, `Block ${i}`);
    }
    await vi.advanceTimersByTimeAsync(10);
    // Burst of 4 used: the new Part, the sketch, Block 1, Block 2. Block 3 waits for the budget.
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
    sketch(doc);
    await vi.advanceTimersByTimeAsync(3500); // the sketch is written after 1.5 s; the budget refills 1.5 s later
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
    sketch(a.doc);
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
    sketch(a.doc);
    await a.doc.flush();
    await saved(a.doc);
    // Tab B had not seen A's sketch: its next save is refused.
    sketch(b.doc, 1);
    await b.doc.flush();
    expect(b.doc.state.get().save).toEqual({ state: 'conflict', message: 'Changed in another tab' });
    expect(b.doc.editable()).toBe('Changed in another tab · Reload to keep editing');
    expect(b.doc.rename(b.doc.state.get().doc.features[0].id, 'x')).toEqual({ ok: false, reason: 'Changed in another tab · Reload to keep editing' });
    // A's model is intact.
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name)).toEqual(['Sketch 1']);
    await b.doc.reload();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(b.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1']);
    expect(b.doc.editable()).toBe(true);
  });

  it('a rename in the host header is adopted silently (no conflict)', async () => {
    const { ws, doc } = make();
    await doc.load();
    const rec = await ws.study.get();
    await ws.study.update({ title: 'Renamed' }, rec.rev);
    sketch(doc);
    await doc.flush();
    expect(doc.state.get().save.state).toBe('saved');
    expect((doc as unknown as { studyRev: number }).studyRev).toBe(rec.rev + 1);
  });

  it('pagehide posts the pending model at once (the host removes the frame on Back)', async () => {
    const { ws, doc } = make({ interval: 60_000, burst: 1 });
    await doc.load();
    // The budget is used by the new Part's first write: the change waits.
    sketch(doc);
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
    sketch(doc); // 2 of the 6
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
    sketch(doc);
    expect(doc.state.get().save.state).toBe('pending');
    const before = reads.mock.calls.length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    // In the store before the key event returned, with no read first (a reload does not wait for a second round trip).
    expect(stored()).toEqual(['Sketch 1']);
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
    sketch(doc); // a usual save starts: its read hangs
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
    sketch(doc);
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
    sketch(a.doc);
    sketch(a.doc);
    expect(a.doc.state.get().save.state).toBe('pending');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }));
    await saved(a.doc);
    // B had not seen A's sketches: its save is refused, and A's model stays.
    sketch(b.doc, 1);
    await b.doc.flush();
    expect(b.doc.state.get().save.state).toBe('conflict');
    expect((ws.json(MODEL) as { doc: { features: { name: string }[] } }).doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Sketch 2']);
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
    sketch(a.doc);
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
    sketch(a.doc);
    await a.doc.flush();
    expect(a.doc.state.get().save.state).toBe('saved');
    sketch(b.doc, 1);
    await b.doc.flush();
    expect(b.doc.state.get().save).toEqual({ state: 'conflict', message: 'Changed in another tab' });
    expect(featureNames(ws.json(MODEL))).toEqual(['Sketch 1']);
    await b.doc.reload();
    expect(b.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1']);
    expect(b.doc.state.get().save.state).toBe('saved');
    sketch(b.doc, 1);
    await b.doc.flush();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(featureNames(ws.json(MODEL))).toEqual(['Sketch 1', 'Sketch 2']);
  });

  it('a P1 Part (kept with ws.data) moves to ws.files once: the P1 file is kept byte for byte, the model is written on the etag it was read at', async () => {
    const ws = host12();
    const p1 = make({ ws, noFiles: true });
    await p1.doc.load();
    sketch(p1.doc);
    await p1.doc.flush();
    expect((await ws.study.get()).doc).toMatchObject({ store: 'data' });
    const before = ws.folder.entries.get(MODEL)!;
    const p1Bytes = new TextDecoder().decode(before.bytes);
    expect((ws.json(MODEL) as { etag: string }).etag).toMatch(/^\d+\./);
    p1.doc.dispose();

    const now = make({ ws });
    await now.doc.load();
    expect((await ws.study.get()).doc).toEqual({ rel: MODEL, schema: 1, store: 'files', view: VIEW });
    expect(now.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1']);
    // Kept as it was (never deleted), then the model written through ws.files on the version read.
    expect(new TextDecoder().decode(ws.folder.entries.get('studies/st-test/model.p1.json')!.bytes)).toBe(p1Bytes);
    expect(ws.files.writes).toEqual([
      { rel: 'studies/st-test/model.p1.json', ifMatch: null },
      { rel: MODEL, ifMatch: before.etag },
    ]);
    expect((ws.json(MODEL) as { etag?: string }).etag).toBeUndefined();
    sketch(now.doc, 1);
    await now.doc.flush();
    expect(featureNames(ws.json(MODEL))).toEqual(['Sketch 1', 'Sketch 2']);
    now.doc.dispose();

    // Opened again: nothing moves a second time.
    const writes = ws.files.writes.length;
    const again = make({ ws });
    await again.doc.load();
    expect(ws.files.writes.length).toBe(writes);
    expect(again.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1', 'Sketch 2']);
  });

  it('a tab still on ws.data when the model moved gets "Changed in another tab", not a silent overwrite', async () => {
    const ws = host12();
    const old = make({ ws, noFiles: true });
    await old.doc.load();
    sketch(old.doc);
    await old.doc.flush();
    const next = make({ ws });
    await next.doc.load();
    expect((await ws.study.get()).doc).toMatchObject({ store: 'files' });
    sketch(old.doc, 1);
    await old.doc.flush();
    expect(old.doc.state.get().save.state).toBe('conflict');
    expect(featureNames(ws.json(MODEL))).toEqual(['Sketch 1']);
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
    sketch(doc);
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
    sketch(doc);
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

  it('a value typed in a panel field and not applied is unsaved work; the pointer leaving applies a whole one; the frame losing focus applies nothing (SD review round 2, LINK polish)', async () => {
    const ws = host12();
    const { doc } = make({ ws, interval: 60_000, burst: 1 });
    await doc.load();
    await saved(doc);
    ws.log.dirty.length = 0;
    // A field holding typed text (as NumberUnitInput registers itself): its commit adds a sketch.
    let text: string | null = 'Block';
    let error: string | null = null;
    const off = registerPendingEdit({
      label: 'Distance',
      pending: () => text !== null,
      error: () => error,
      commit: () => {
        if (text === 'bad') {
          error = 'Distance must not be 0';
          pendingEditsChanged();
          return;
        }
        sketch(doc);
        text = null;
      },
      // A whole value the field takes, not typed a moment ago (NumberUnitInput's rule).
      commitQuiet: () => {
        if (text === 'Block') {
          sketch(doc);
          text = null;
        }
      },
    });
    // The question names the field, and its "Leaving discards them" is true.
    expect(ws.log.dirty).toEqual([{ dirty: true, message: 'Changes typed in Distance of Part 1 are not applied yet.' }]);
    // The frame losing focus (the app's header or dialog) applies nothing: the text waits.
    const before = doc.state.get().doc.features.length;
    window.dispatchEvent(new Event('blur'));
    expect(doc.state.get().doc.features.length).toBe(before);
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: true, message: 'Changes typed in Distance of Part 1 are not applied yet.' });
    // A mouseleave with the pointer still over the frame: the app's leave question came over it
    // under a pointer that did not move (the browser's Back). Not the pointer leaving: nothing applied.
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { clientX: 531, clientY: 367 }));
    expect(doc.state.get().doc.features.length).toBe(before);
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: true, message: 'Changes typed in Distance of Part 1 are not applied yet.' });
    // The pointer leaves the frame (Back, Settings, the browser's controls are all outside it): applied, then written.
    document.documentElement.dispatchEvent(new MouseEvent('mouseleave', { clientX: 72, clientY: -23 }));
    expect(doc.state.get().doc.features.length).toBe(before + 1);
    await saved(doc);
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: false, message: '' });
    // A refused value stays unsaved work, with the field and the reason in the question.
    text = 'bad';
    pendingEditsChanged();
    commitPendingEdits();
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: true, message: 'Changes to Part 1 are not saved: the value typed in Distance is not applied. Distance must not be 0.' });
    off();
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: false, message: '' });
  });

  it('leaving (F5, the side buttons, hidden) writes with ifMatch: on a 1.2 host there is no write without the check', async () => {
    const ws = host12();
    const { doc } = make({ ws, interval: 60_000, burst: 1 });
    await doc.load();
    sketch(doc);
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
    sketch(doc);
    expect(await commands.run('edit.undo')).toBe(true);
    expect(doc.state.get().doc.features).toEqual([]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
    await vi.waitFor(() => expect(doc.state.get().doc.features).toHaveLength(1));
    off();
    keyboard.dispose();
  });
});

describe('LINK: the design version, the include toggle, Keep mine', () => {
  const host12 = () => createFakeWorkspace({ hostVersion: '1.2' });
  const fileVersion = (ws: FakeWorkspace) => (ws.json(MODEL) as { source_version?: number }).source_version;

  it('every save writes the next save counter into the model file; undo to the stored model writes nothing; a reopen reads it', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    // A new Part is stored at once: version 1.
    expect([a.doc.state.get().sourceVersion, fileVersion(ws)]).toEqual([1, 1]);
    sketch(a.doc);
    await a.doc.flush();
    expect([a.doc.state.get().sourceVersion, fileVersion(ws)]).toEqual([2, 2]);
    sketch(a.doc, 1);
    await a.doc.flush();
    expect(fileVersion(ws)).toBe(3);
    a.doc.undo();
    await a.doc.flush();
    expect(fileVersion(ws)).toBe(4);
    a.doc.redo();
    await a.doc.flush();
    expect(fileVersion(ws)).toBe(5);
    a.doc.dispose();
    const b = make({ ws });
    await b.doc.load();
    expect(b.doc.state.get().sourceVersion).toBe(5);
    // Nothing changed: nothing written, the counter stays.
    await b.doc.flush();
    expect(fileVersion(ws)).toBe(5);
  });

  it('never goes down: a study record that holds a newer version wins at load, and the next save goes past it', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    a.doc.dispose();
    const rec = await ws.study.get();
    await ws.study.update({ source_version: 40 }, rec.rev);
    const b = make({ ws });
    await b.doc.load();
    expect(b.doc.state.get().sourceVersion).toBe(40);
    sketch(b.doc);
    await b.doc.flush();
    expect(fileVersion(ws)).toBe(41);
  });

  it('after a save the study record gets source_version, at most one write per 1.5 s, the newest last; not while nothing is linked', async () => {
    let linkedNow: unknown = null;
    const ws = createFakeWorkspace({ hostVersion: '1.5', linked: () => linkedNow });
    const writes: unknown[] = [];
    const update = ws.study.update.bind(ws.study);
    ws.study.update = async (patch: Record<string, unknown>, rev: number) => {
      if ('source_version' in patch) writes.push(patch.source_version);
      return update(patch, rev);
    };
    const { doc } = make({ ws, interval: 1, burst: 50 });
    await doc.load();
    // Not linked yet: the first save writes nothing into the record.
    await doc.recordSettled();
    expect((await ws.study.get()).source_version).toBeUndefined();
    expect(writes).toEqual([]);
    linkedNow = { geometryId: 'g1', name: 'Part 1', rev: 1, sourceVersion: 1 };
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      sketch(doc, i);
      await doc.flush();
    }
    expect(doc.state.get().sourceVersion).toBe(6);
    await doc.recordSettled();
    const took = Date.now() - t0;
    expect((await ws.study.get()).source_version).toBe(6);
    // On the real clock only what holds on any machine (Linux CI under load: the first write
    // came after all five saves, as 6): the counters in order, the newest last, at most one write
    // per 1.5 s. "The first at once, then the newest after 1.5 s" is pinned on fake timers in
    // tests/doc/source-record.test.ts.
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w, i) => i === 0 || Number(w) > Number(writes[i - 1]))).toBe(true);
    expect(Number(writes[0])).toBeGreaterThanOrEqual(2);
    expect(writes.at(-1)).toBe(6);
    expect(writes.length).toBeLessThanOrEqual(1 + Math.floor(took / 1500));
  }, 15_000);

  it('Include in simulation: on by default, off is one undo step, saved, and read back', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    const made = block(a.doc);
    await rebuilt(a.doc);
    const id = made.body!;
    expect(a.doc.state.get().doc.bodies[id].simulation).toBeUndefined();
    const before = a.doc.state.get().sourceVersion;
    expect(a.doc.setBodyInSimulation(id, false)).toEqual({ ok: true });
    expect(a.doc.state.get().doc.bodies[id].simulation).toBe(false);
    expect(a.doc.state.get().history.undoLabel).toBe('Leave Body 1 out of the simulation');
    await a.doc.flush();
    expect(a.doc.state.get().sourceVersion).toBe(before + 1);
    expect((ws.json(MODEL) as { doc: { bodies: Record<string, { simulation?: boolean }> } }).doc.bodies[id].simulation).toBe(false);
    a.doc.dispose();
    const b = make({ ws });
    await b.doc.load();
    expect(b.doc.state.get().doc.bodies[id].simulation).toBe(false);
    expect(b.doc.setBodyInSimulation(id, true)).toEqual({ ok: true });
    expect(b.doc.state.get().doc.bodies[id].simulation).toBeUndefined();
    b.doc.undo();
    expect(b.doc.state.get().doc.bodies[id].simulation).toBe(false);
  });

  it('Keep mine after another tab saved: this tab\'s model replaces it, its counter goes past both, and the other tab is told when it saves next', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    const b = make({ ws });
    await b.doc.load();
    sketch(a.doc);
    sketch(a.doc, 1);
    await a.doc.flush();
    await saved(a.doc);
    const aVersion = fileVersion(ws)!;
    sketch(b.doc, 2);
    await b.doc.flush();
    expect(b.doc.state.get().save.state).toBe('conflict');
    await b.doc.keepMine();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(featureNamesOf(ws.json(MODEL))).toEqual(['Sketch 1']);
    expect(fileVersion(ws)).toBe(aVersion + 1);
    expect(b.doc.state.get().sourceVersion).toBe(aVersion + 1);
    expect(b.doc.editable()).toBe(true);
    // A's next save meets B's: the conflict chip, nothing overwritten.
    sketch(a.doc, 3);
    await a.doc.flush();
    expect(a.doc.state.get().save.state).toBe('conflict');
    expect(featureNamesOf(ws.json(MODEL))).toEqual(['Sketch 1']);
  });
});

function featureNamesOf(file: unknown): string[] {
  return (file as { doc: { features: { name: string }[] } }).doc.features.map((x) => x.name);
}

describe('UX review: one write per drag, a tab another tab saved over', () => {
  const host12 = () => createFakeWorkspace({ hostVersion: '1.2' });

  it('holdSaves: changes made while an arrow is dragged are written once, on release; leaving still writes', async () => {
    const { doc, ws } = make({ interval: undefined });
    await doc.load();
    sketch(doc);
    await doc.flush();
    await saved(doc);
    const writes = () => ws.log.dataWrites.filter((w) => w.rel === MODEL).length;
    const first = writes();
    const release = doc.holdSaves();
    const s = doc.beginNew('sketch', blockSketch(60, 0) as Partial<Feature>);
    for (let i = 1; i <= 8; i++) s.update({ points: { ...blockSketch(60, 0).points, pt_2: [70 + i, 0] } } as Partial<Feature>);
    await new Promise((r) => setTimeout(r, 30));
    expect(writes()).toBe(first);
    expect(doc.state.get().save.state).toBe('pending');
    release();
    await vi.waitFor(() => expect(doc.state.get().save.state).toBe('saved'), { timeout: 3000, interval: 5 });
    expect(writes()).toBe(first + 1);
    // Released twice: nothing more.
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(writes()).toBe(first + 1);
    // Held again: a flush (Done, leaving) still writes.
    const again = doc.holdSaves();
    s.update({ points: { ...blockSketch(60, 0).points, pt_2: [90, 0] } } as Partial<Feature>);
    await doc.flush();
    expect(writes()).toBe(first + 2);
    again();
    s.commit();
  });

  it('checkStored: a clean tab whose model another tab saved over says "Updated in another tab" when it is checked (window focus), never dirty; Reload adopts it (L3 review B1)', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    const b = make({ ws });
    await b.doc.load();
    await saved(b.doc);
    sketch(a.doc);
    await a.doc.flush();
    await saved(a.doc);
    expect(b.doc.state.get().save.state).toBe('saved');
    // A tab's own state is not touched while nothing else wrote.
    await a.doc.checkStored();
    expect(a.doc.state.get().save.state).toBe('saved');
    // The window regains focus: both tabs check; B, which changed nothing, finds A's save.
    const told = ws.log.dirty.length;
    window.dispatchEvent(new FocusEvent('focus'));
    await vi.waitFor(() => expect(b.doc.state.get().save).toEqual({ state: 'updated', message: 'Updated in another tab' }), { timeout: 3000, interval: 5 });
    expect(a.doc.state.get().save.state).toBe('saved');
    // Nothing of B's is unsaved: the app is never told B is dirty (it was: "conflict" said so).
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.log.dirty.slice(told).filter((d) => d.dirty)).toEqual([]);
    expect(b.doc.editable()).toBe('Updated in another tab · Reload to keep editing');
    await b.doc.reload();
    expect(b.doc.state.get().save.state).toBe('saved');
    expect(b.doc.state.get().doc.features.map((f) => f.name)).toEqual(['Sketch 1']);
  });

  it('a tab with a change of its own that another tab saved over still gets the conflict (both edited), and it is dirty', async () => {
    const ws = host12();
    const a = make({ ws });
    await a.doc.load();
    const b = make({ ws });
    await b.doc.load();
    await saved(b.doc);
    sketch(a.doc);
    await a.doc.flush();
    await saved(a.doc);
    sketch(b.doc, 1);
    await b.doc.flush();
    await vi.waitFor(() => expect(b.doc.state.get().save).toEqual({ state: 'conflict', message: 'Changed in another tab' }), { timeout: 3000, interval: 5 });
    expect(ws.log.dirty.at(-1)).toEqual({ dirty: true, message: 'Changes to Part 1 are not saved: it was changed in another tab.' });
  });

  it('suppressRemoved: every removed Box and Cylinder is suppressed in one undo step, its data kept; Undo brings them back (L3 review B2)', async () => {
    const ws = createFakeWorkspace({ study: { doc: { rel: MODEL, schema: 1, store: 'data', view: VIEW } } });
    ws.folder.putJson(MODEL, {
      format: 'magnusim-cad/model',
      etag: '3.s_old',
      saved_at: '2026-09-30T20:00:00.000Z',
      doc: {
        schema: 1,
        units: { length: 'mm', angle: 'deg' },
        params: [],
        bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } },
        features: [
          { id: 'f_box', type: 'box', name: 'Old box', op: 'new', creates: 'b_1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['20 mm', '20 mm', '20 mm'] },
          { id: 'f_cyl', type: 'cylinder', name: 'Old cylinder', op: 'cut', creates: null, scope: [], origin: ['10 mm', '10 mm', '-5 mm'], axis: 'origin:z', diameter: '10 mm', height: '40 mm' },
        ],
        meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
      },
    });
    const { doc } = make({ ws });
    await doc.load();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features.f_box).toMatchObject({ state: 'error', message: 'This part uses a removed feature (Old box)' });
    const before = doc.state.get().doc.features;
    expect(doc.suppressRemoved()).toEqual({ ok: true });
    const after = doc.state.get().doc.features;
    expect(after.map((f) => [f.name, !!f.suppressed])).toEqual([
      ['Old box', true],
      ['Old cylinder', true],
    ]);
    // The data is kept: only the suppressed flag changed.
    expect(after.map(({ suppressed: _s, ...f }) => f)).toEqual(before);
    expect(doc.state.get().history.undoLabel).toBe('Suppress the removed features');
    await rebuilt(doc);
    expect(doc.state.get().rebuild.features.f_box?.state).toBe('suppressed');
    // Nothing left to suppress: no second undo step.
    expect(doc.suppressRemoved()).toEqual({ ok: true });
    doc.undo();
    expect(doc.state.get().doc.features.map((f) => !!f.suppressed)).toEqual([false, false]);
    expect(doc.state.get().history.canUndo).toBe(false);
  });
});
