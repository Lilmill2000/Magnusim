// The P2/P3 extension points (docs/p2p3-plan.md §3): schema 2 and its
// migration, module discovery and registry, mode-aware shortcuts, the
// feature-type hooks (uses / ownsBody / newBodies / exprs / mapExprs /
// isolateWhileEditing), feature outputs and parent keys in the rebuild, and
// derived body ids. Fake feature types stand in for the builders' features.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import { createDocService } from '../../src/doc';
import { deriveBodyId, parseDerivedBodyId, storedBodyName } from '../../src/doc/features/body-ids';
import { DocReadError, readDoc, readView } from '../../src/doc/schema';
import { createBridge } from '../../src/lib/bridge';
import { createBus } from '../../src/lib/bus';
import { createStateStore } from '../../src/lib/store';
import { createModuleRegistry, installModules, registerModuleFeatures } from '../../src/modules';
import type { AppServices } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import { DOC_SCHEMA, type CadDoc, type CombineFeature, type Feature, type ImportFeature, type SketchFeature, type SplitFeature } from '../../src/types/doc';
import type { DocService, FeatureTypeDef } from '../../src/types/doc-service';
import type { CadEvents } from '../../src/types/events';
import type { CadModule } from '../../src/types/modules';
import type { SketchOutput } from '../../src/types/sketch';
import { createFakeWorkspace } from '../fakes/workspace-sdk';
import { FakeKernel } from '../doc/fake-kernel';

const services: DocService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.dispose();
});

function make() {
  const ws = createFakeWorkspace();
  const kernel = new FakeKernel();
  const doc = createDocService({ bridge: createBridge(ws), kernel, bus: createBus<CadEvents>(), saveIntervalMs: 20, saveViewIntervalMs: 20, log: () => {} });
  services.push(doc);
  return { ws, kernel, doc };
}

async function rebuilt(doc: DocService) {
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(
    () => {
      const s = doc.state.get();
      expect(s.rebuild.status).toBe('done');
      for (const f of s.doc.features) expect(s.rebuild.features[f.id]?.state, f.name).not.toBe('pending');
    },
    { timeout: 2000, interval: 5 },
  );
  await new Promise((r) => setTimeout(r, 0));
  await vi.waitFor(() => expect(doc.state.get().rebuild.status).toBe('done'), { timeout: 2000, interval: 5 });
}

const P1_DOC = {
  schema: 1,
  units: { length: 'mm', angle: 'deg' },
  params: [],
  bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } },
  features: [{ id: 'f_1', type: 'box', name: 'Box 1', op: 'new', creates: 'b_1', scope: [], origin: ['0', '0', '0'], size: ['10', '10', '10'] }],
  meta: { created_at: '2026-09-30T00:00:00Z', written_by: '0.1.0' },
};

describe('schema 2', () => {
  it('reads a schema-1 Part as schema 2 with every field kept', () => {
    const d = readDoc(P1_DOC);
    expect(d.schema).toBe(DOC_SCHEMA);
    expect(DOC_SCHEMA).toBe(2);
    expect(d.features).toEqual(P1_DOC.features);
    expect(d.bodies).toEqual(P1_DOC.bodies);
  });

  it('refuses a newer schema with the reason', () => {
    expect(() => readDoc({ ...P1_DOC, schema: 3 })).toThrow(DocReadError);
    expect(() => readDoc({ ...P1_DOC, schema: 3 })).toThrow('it was saved by a newer Magnusim CAD (schema 3); this one reads schema 2');
  });

  it('keeps sketch visibility choices in the view and drops anything else', () => {
    const v = readView({ rollback: null, hiddenBodies: [], expanded: [], sketches: { f_s: 'hidden', f_t: 'shown', f_u: 'maybe' } }, 3);
    expect(v.sketches).toEqual({ f_s: 'hidden', f_t: 'shown' });
  });
});

describe('derived body ids', () => {
  it('piece 0 keeps the target id; the others derive from the feature and parse back', () => {
    expect(deriveBodyId('f_ab12', 'b_x', 0)).toBe('b_x');
    const id = deriveBodyId('f_ab12', 'b_x', 2);
    expect(id).toBe('b_x.ab12.2');
    expect(parseDerivedBodyId('f_ab12', id)).toEqual({ target: 'b_x', k: 2 });
    expect(parseDerivedBodyId('f_other', id)).toBeNull();
    expect(parseDerivedBodyId('f_ab12', 'b_x')).toBeNull();
  });

  // Review P2/P3 round 1: a split piece a Combine used up was listed as "A deleted body".
  it('names a derived body from the Part alone: the stored name, else "<target> (k+1)", also a piece of a piece', () => {
    const features = [{ id: 'f_ab12' }, { id: 'f_cd34' }] as never;
    const doc = { bodies: { b_x: { name: 'flange', color: '#bdc9db' } }, features };
    expect(storedBodyName(doc, 'b_x')).toBe('flange');
    expect(storedBodyName(doc, 'b_x.ab12.1')).toBe('flange (2)');
    expect(storedBodyName(doc, 'b_x.ab12.1.cd34.2')).toBe('flange (2) (3)');
    expect(storedBodyName({ ...doc, bodies: { ...doc.bodies, 'b_x.ab12.1': { name: 'Half', color: '#bdc9db' } } }, 'b_x.ab12.1')).toBe('Half');
    expect(storedBodyName(doc, 'b_gone')).toBeNull();
    expect(storedBodyName(doc, 'b_gone.ab12.1')).toBeNull();
  });
});

describe('modules', () => {
  const panel = () => null;
  it('registers feature types, panels and tools once, and installs in order with a reverse uninstall', () => {
    const order: string[] = [];
    const def = { type: 'combine', label: 'Combine', icon: 'M0 0' } as unknown as FeatureTypeDef;
    const a: CadModule = { id: 'a', features: [def], panels: { combine: panel }, install: () => (order.push('in a'), () => order.push('out a')) };
    const b: CadModule = { id: 'b', tools: [{ id: 'inspect.measure', label: 'Measure', panel }], install: () => (order.push('in b'), () => order.push('out b')) };
    const reg = createModuleRegistry([a, b]);
    expect(reg.panelFor('combine')).toBe(panel);
    expect(reg.panelFor('enclosure')).toBeNull();
    expect(reg.tool('inspect.measure')?.label).toBe('Measure');
    const registered: string[] = [];
    registerModuleFeatures({ register: (d) => registered.push(d.type), get: () => undefined, all: () => [] }, [a, b]);
    expect(registered).toEqual(['combine']);
    const off = installModules({} as AppServices, [a, b]);
    off();
    expect(order).toEqual(['in a', 'in b', 'out b', 'out a']);
  });

  it('refuses two modules that register the same id, feature type, panel or tool', () => {
    const def = { type: 'split' } as unknown as FeatureTypeDef;
    expect(() => createModuleRegistry([{ id: 'x' }, { id: 'x' }])).toThrow(/two modules/);
    expect(() => createModuleRegistry([{ id: 'x', features: [def] }, { id: 'y', features: [def] }])).toThrow(/split is already registered/);
    expect(() => createModuleRegistry([{ id: 'x', panels: { split: panel } }, { id: 'y', panels: { split: panel } }])).toThrow(/split panel/);
    expect(() => createModuleRegistry([{ id: 'x', tools: [{ id: 't', label: 'T', panel }] }, { id: 'y', tools: [{ id: 't', label: 'T', panel }] }])).toThrow(/tool t/);
  });
});

describe('mode-aware shortcuts', () => {
  it('runs the command of the current mode, and passes a key no command of this mode has to older bindings', async () => {
    const mode = createStateStore<{ mode: Mode }>({ mode: 'model' });
    const reg = createCommandRegistry(() => ({}) as AppServices);
    const kb = createKeyboard(document);
    const ran: string[] = [];
    kb.bind({ combo: 'Delete', run: () => void ran.push('raw delete') });
    reg.register({ id: 'edit.undo', label: 'Undo', shortcut: 'Ctrl+Z', run: () => void ran.push('model undo') });
    reg.register({ id: 'sketch.undo', label: 'Undo', shortcut: 'Ctrl+Z', mode: 'sketch', run: () => void ran.push('sketch undo') });
    reg.register({ id: 'sketch.delete', label: 'Delete', shortcut: 'Delete', mode: 'sketch', run: () => void ran.push('sketch delete') });
    reg.register({ id: 'view.fit', label: 'Fit', shortcut: 'F', mode: 'any', run: () => void ran.push('fit') });
    bindCommandShortcuts(reg, kb, undefined, () => mode.get().mode);
    const key = (k: string, ctrl = false) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: ctrl, bubbles: true }));
    key('z', true);
    key('Delete');
    key('f');
    mode.set({ mode: 'sketch' });
    key('z', true);
    key('Delete');
    key('f');
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toEqual(['model undo', 'raw delete', 'fit', 'sketch undo', 'sketch delete', 'fit']);
    expect(reg.canRun('sketch.undo')).toBe(true);
    expect(reg.canRun('nope')).toBe('Unknown command nope');
    kb.dispose();
  });

  it('keeps a primary command out of the groups (the toolbar draws it on its own) and needs a group for it', () => {
    const reg = createCommandRegistry(() => ({}) as AppServices);
    reg.register({ id: 'sketch.line', label: 'Line', group: 'draw', mode: 'sketch', icon: 'M0 0', run() {} });
    reg.register({ id: 'sketch.finish', label: 'Finish sketch', group: 'draw', mode: 'sketch', icon: 'M0 0', primary: true, run() {} });
    expect(reg.toolbar('sketch')[0].commands.map((c) => c.id)).toEqual(['sketch.line']);
    expect(() => reg.register({ id: 'x', label: 'X', primary: true, run() {} })).toThrow(/needs a group/);
  });
});

// ---------------------------------------------------------------- fake feature types

/** A sketch-like type: no bodies, an output from its points, isolates while edited. */
function sketchDef(builds: string[]): FeatureTypeDef<SketchFeature, null> {
  return {
    type: 'sketch',
    label: 'Sketch',
    icon: 'M0 0',
    isolateWhileEditing: true,
    create: (doc, init = {}) => ({
      id: init.id ?? 'f_sk',
      type: 'sketch',
      name: 'Sketch 1',
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: { pt_a: [0, 0] },
      entities: [],
      constraints: [],
      solved: { values: {}, dof: 0, state: 'fully' },
      ...init,
    }),
    resolve: () => ({ ok: true, values: null }),
    incomplete: () => null,
    parents: () => [],
    exprs: (f) => f.constraints.flatMap((c, i) => ('expr' in c ? [{ path: `constraints[${i}].expr`, expr: c.expr }] : [])),
    mapExprs: (f, fn) => ({ ...f, constraints: f.constraints.map((c) => ('expr' in c ? { ...c, expr: fn(c.expr) } : c)) }),
    async build(f) {
      builds.push(f.id);
      const out: SketchOutput = { type: 'sketch', plane: f.plane, points: f.points, radii: {}, curves: [], regions: [], open: [], dangling: [], measured: {}, source: 'stored' };
      return { ok: true, bodies: [], removed: [], output: out };
    },
  };
}

/** An extrude-like type reading its sketch's output: makes a box whose size is the sketch's point u. */
function extrudeDef(builds: string[]): FeatureTypeDef<CombineFeature, null> {
  // Uses the 'combine' slot of the union as a stand-in type (the fake needs a feature type the union knows).
  return {
    type: 'combine',
    label: 'Fake extrude',
    icon: 'M0 0',
    create: (doc, init = {}) => ({ id: 'f_ex', type: 'combine', name: 'Fake 1', op: 'join', targets: ['f_sk'], tools: [], keepTools: false, ...init }),
    resolve: () => ({ ok: true, values: null }),
    incomplete: () => null,
    parents: (f) => f.targets,
    exprs: () => [],
    mapExprs: (f) => f,
    async build(f, _v, ctx) {
      builds.push(f.id);
      const out = ctx.outputs.get(f.targets[0]);
      if (!out || out.type !== 'sketch') return { ok: false, message: 'no sketch output' };
      const size = 10 + out.points.pt_a[0];
      const r = await ctx.kernel.call('box', { dx: size, dy: 10, dz: 10 });
      return { ok: true, bodies: [{ id: 'b_ex', shape: r.result.id, valid: true }], removed: [] };
    },
    ownsBody: (_f, id) => id === 'b_ex',
    newBodies: () => ({ b_ex: { name: 'Extruded', color: '#123456' } }),
  };
}

describe('feature hooks, outputs and parent keys (DocService + rebuild)', () => {
  it('publishes outputs, rebuilds a child when its parent changes, and isolates a sketch while it is edited', async () => {
    const { doc } = make();
    const builds: string[] = [];
    doc.features.register(sketchDef(builds));
    doc.features.register(extrudeDef(builds));
    await doc.load();
    doc.beginNew('sketch').commit();
    doc.beginNew('combine').commit();
    await rebuilt(doc);
    let s = doc.state.get();
    expect(s.rebuild.outputs.f_sk?.type).toBe('sketch');
    expect(s.doc.bodies.b_ex).toEqual({ name: 'Extruded', color: '#123456' });
    expect(s.rebuild.bodies.map((b) => [b.id, b.name, b.volume])).toEqual([['b_ex', 'Extruded', 1000]]);

    // Editing the sketch: the rebuild stops after it (the extrude shows rolled back) and the extrude is not rebuilt.
    builds.length = 0;
    const session = doc.beginEdit('f_sk');
    session.update({ points: { pt_a: [5, 0] } } as Partial<Feature>);
    await rebuilt(doc);
    s = doc.state.get();
    expect(s.rebuild.features.f_ex.state).toBe('rolled-back');
    expect(s.rebuild.bodies).toEqual([]);
    expect(builds).toEqual(['f_sk']);
    expect(s.view.rollback).toBeNull();

    // Done: everything rebuilds; the extrude saw the new sketch output (its parent key changed).
    session.commit();
    await rebuilt(doc);
    s = doc.state.get();
    expect(s.rebuild.features.f_ex.state).toBe('ok');
    expect(s.rebuild.bodies.map((b) => b.volume)).toEqual([1500]);
    expect(builds).toEqual(['f_sk', 'f_ex']);

    // A rename rebuilds nothing.
    builds.length = 0;
    doc.rename('f_sk', 'Profile sketch');
    await rebuilt(doc);
    expect(builds).toEqual([]);

    // The parent guard knows the extrude uses the sketch, and the body's maker through ownsBody.
    expect(doc.remove('f_sk')).toEqual({ ok: false, reason: 'Fake 1 uses Profile sketch: delete Fake 1 or change what it uses first' });
  });

  it('a sketch built before the solver ran is built again (solved) once the solver starts (P3 integration)', async () => {
    // Before: the rebuild cached the "stored shape, the solver is not running" result under a key
    // that did not change when the solver started, so the sketch kept its stale shape.
    const ws = createFakeWorkspace();
    const apis = createStateStore<{ solver: object | null }>({ solver: null });
    const doc = createDocService({
      bridge: createBridge(ws),
      kernel: new FakeKernel(),
      bus: createBus<CadEvents>(),
      saveIntervalMs: 20,
      saveViewIntervalMs: 20,
      log: () => {},
      solver: () => apis.get().solver as never,
      onSolverChange: (fn) => apis.subscribe(fn),
    });
    services.push(doc);
    const def = sketchDef([]);
    const sources: string[] = [];
    doc.features.register({
      ...def,
      async build(f, v, ctx) {
        const r = await def.build(f, v, ctx);
        if (r.ok && r.output?.type === 'sketch') r.output.source = ctx.solver ? 'solved' : 'stored-unsolved';
        sources.push(r.ok && r.output?.type === 'sketch' ? r.output.source : 'none');
        return r;
      },
    });
    await doc.load();
    doc.beginNew('sketch').commit();
    await rebuilt(doc);
    expect((doc.state.get().rebuild.outputs.f_sk as SketchOutput).source).toBe('stored-unsolved');
    apis.set({ solver: {} });
    await vi.waitFor(() => expect((doc.state.get().rebuild.outputs.f_sk as SketchOutput).source).toBe('solved'), { timeout: 2000, interval: 5 });
    expect(sources).toEqual(['stored-unsolved', 'solved']);
  });

  it('a parameter rename rewrites only the expression fields a type lists', async () => {
    const { doc } = make();
    doc.features.register(sketchDef([]));
    await doc.load();
    const id = doc.addParam({ name: 'side', expr: '10 mm', quantity: 'length' });
    expect(typeof id).toBe('string');
    const s = doc.beginNew('sketch', {
      // A reference name containing the parameter's name must not change.
      support: { kind: 'face', body: 'b_1', face: { name: 'F:f_x:side:e_1[p:pt_a>p:pt_b]', signature: { kind: 'face', type: 'plane', at: [0, 0, 0] } } },
      constraints: [{ id: 'c_1', kind: 'distance', refs: ['pt_a', 'pt_b'], expr: 'side * 2', driving: true }],
    } as Partial<Feature>);
    s.commit();
    expect(doc.updateParam(id as string, { name: 'width' })).toEqual({ ok: true });
    const f = doc.state.get().doc.features[0] as SketchFeature;
    expect(f.constraints[0]).toMatchObject({ expr: 'width * 2' });
    expect(f.support.kind === 'face' && f.support.face.name).toBe('F:f_x:side:e_1[p:pt_a>p:pt_b]');
    expect(doc.removeParam(id as string)).toEqual({ ok: false, reason: "width can't be deleted: Sketch 1 uses it" });
  });

  it('a body a feature derives (a split piece) is named by the feature, renamed into a BodyDef, and kept while the feature is there', async () => {
    const { doc } = make();
    const piece = deriveBodyId('f_sp', 'b_t', 1);
    const split: FeatureTypeDef<SplitFeature, null> = {
      type: 'split',
      label: 'Split',
      icon: 'M0 0',
      create: (doc, init = {}) => ({ id: 'f_sp', type: 'split', name: 'Split 1', targets: [], tool: { kind: 'plane', plane: 'origin:top', offset: '0' }, ...init }),
      resolve: () => ({ ok: true, values: null }),
      incomplete: () => null,
      parents: () => [],
      exprs: (f) => (f.tool.kind === 'plane' ? [{ path: 'tool.offset', expr: f.tool.offset }] : []),
      mapExprs: (f) => f,
      ownsBody: (f, id) => parseDerivedBodyId(f.id, id) != null,
      async build(_f, _v, ctx) {
        const r = await ctx.kernel.call('box', { dx: 1, dy: 2, dz: 3 });
        return { ok: true, bodies: [{ id: piece, shape: r.result.id, valid: true, name: 'Body 1 (2)', color: '#ff0000' }], removed: [] };
      },
    };
    doc.features.register(split);
    await doc.load();
    doc.beginNew('split').commit();
    await rebuilt(doc);
    expect(doc.state.get().rebuild.bodies.map((b) => [b.id, b.name, b.color])).toEqual([[piece, 'Body 1 (2)', '#ff0000']]);
    expect(doc.state.get().doc.bodies[piece]).toBeUndefined();
    expect(doc.renameBody(piece, 'Lower half')).toEqual({ ok: true });
    expect(doc.state.get().doc.bodies[piece]).toEqual({ name: 'Lower half', color: '#ff0000' });
    // Another session's commit runs the body clean-up: the derived body's def stays (its feature owns it).
    doc.beginEdit('f_sp').commit();
    expect(doc.state.get().doc.bodies[piece]?.name).toBe('Lower half');
  });

  it('an import-like type brings its BodyDefs when it enters the document, and they go with it', async () => {
    const { doc } = make();
    const imp: FeatureTypeDef<ImportFeature, null> = {
      type: 'import',
      label: 'Imported',
      icon: 'M0 0',
      create: (d: CadDoc, init = {}) => ({
        id: 'f_imp',
        type: 'import',
        name: 'Imported 1 (flange.step)',
        source: { rel: 'studies/s/imports/aa/source.step', size: 1, sha256: 'aa', fileName: 'flange.step' },
        brep: { rel: 'studies/s/imports/aa/healed-0.001.brep', size: 1, sha256: 'bb', occt: '7.9.3' },
        heal: { tolerance: 0.001, sew: false },
        items: [
          { body: 'b_i1', index: 0, stepName: 'Flange', stepColor: '#a0a0a0', kind: 'solid', valid: true },
          { body: 'b_i2', index: 1, stepName: 'Gasket', stepColor: null, kind: 'solid', valid: true },
        ],
        ...init,
      }),
      resolve: () => ({ ok: true, values: null }),
      incomplete: () => null,
      parents: () => [],
      exprs: () => [],
      mapExprs: (f) => f,
      ownsBody: (f, id) => f.items.some((i) => i.body === id),
      newBodies: (f) => Object.fromEntries(f.items.map((i) => [i.body, { name: i.stepName, color: i.stepColor ?? '#bdc9db' }])),
      build: async () => ({ ok: true, bodies: [], removed: [] }),
    };
    doc.features.register(imp);
    await doc.load();
    doc.beginNew('import').commit();
    expect(doc.state.get().doc.bodies).toEqual({ b_i1: { name: 'Flange', color: '#a0a0a0' }, b_i2: { name: 'Gasket', color: '#bdc9db' } });
    await rebuilt(doc);
    expect(doc.remove('f_imp')).toEqual({ ok: true });
    expect(doc.state.get().doc.bodies).toEqual({});
  });
});
