// Test-only fakes for the UI shell's unit tests: an in-memory DocService (the
// src/types/doc-service.ts contract, with stand-ins for the extrude (a body
// maker: 10 x 20 x its distance) and sketch (no body) types, sessions, undo,
// rollback, parameters and a synchronous fake rebuild), a units service with a
// small expression evaluator, and (makeServices({ panels: true })) a plain
// feature panel for those types. Never used by shipped code.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createBus } from '../../src/lib/bus';
import { createBridge } from '../../src/lib/bridge';
import { newId, nextName } from '../../src/lib/ids';
import { createSelectionStore } from '../../src/lib/selection';
import { createStateStore } from '../../src/lib/store';
import { createCommandRegistry } from '../../src/app/commands';
import { bindCommandShortcuts, createKeyboard } from '../../src/app/keyboard';
import { createModuleRegistry } from '../../src/modules';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { Mode } from '../../src/types/commands';
import type { DocService, DocState, EditResult, EditSession, FeatureRegistry, FeatureTypeDef } from '../../src/types/doc-service';
import type { BodyId, CadDoc, CadView, ExtrudeFeature, Feature, FeatureId, FeatureStatus, FeatureType, Param, SketchFeature } from '../../src/types/doc';
import type { CadModule } from '../../src/types/modules';
import { TestFeaturePanel } from './test-panel';
import type { CadEvents } from '../../src/types/events';
import type { BodyInfo, KernelAdapter, KernelStatus } from '../../src/types/kernel';
import type { DocUnits, EvalResult, Quantity, UnitsService } from '../../src/types/units';
import type { ViewportHandle } from '../../src/types/viewport';
import { formatQuantity, MM_PER, DEG_PER } from '../../src/ui/kit/format';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

// ---------------------------------------------------------------- expressions

type Tok = { t: 'num'; v: number; unit: string } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      const u = /^\s*(mm|cm|m|in|ft|deg|rad|°)(?![A-Za-z0-9_])/.exec(src.slice(i));
      if (u) i += u[0].length;
      out.push({ t: 'num', v: Number(num[0]), unit: u ? u[1] : '' });
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    return `Unexpected "${c}"`;
  }
  return out;
}

export function createFakeUnits(getDoc: () => Pick<CadDoc, 'units' | 'params'>): UnitsService {
  const units = () => getDoc().units;
  function evalExpr(text: string, quantity: Quantity, stack: string[]): EvalResult {
    const toks = tokenize(text);
    if (typeof toks === 'string') return { ok: false, error: toks };
    if (!toks.length) return { ok: false, error: 'Enter a value' };
    const uses: string[] = [];
    let pos = 0;
    const single = toks.length === 1 && toks[0].t === 'num';
    const fail = (e: string): never => {
      throw new Error(e);
    };
    const primary = (): number => {
      const tk = toks[pos++];
      if (!tk) return fail('The expression ends too early');
      if (tk.t === 'op' && tk.v === '(') {
        const v = sum();
        const close = toks[pos++];
        if (!close || close.t !== 'op' || close.v !== ')') fail('Missing ")"');
        return v;
      }
      if (tk.t === 'op' && tk.v === '-') return -primary();
      if (tk.t === 'num') {
        if (tk.unit) {
          if (tk.unit in MM_PER) {
            if (quantity !== 'length') fail(`${tk.unit} is not a unit of ${quantity === 'angle' ? 'angle' : 'a plain number'}`);
            return tk.v * MM_PER[tk.unit as keyof typeof MM_PER];
          }
          const au = tk.unit === '°' ? 'deg' : tk.unit;
          if (quantity !== 'angle') fail(`${tk.unit} is not a unit of ${quantity === 'length' ? 'length' : 'a plain number'}`);
          return tk.v * DEG_PER[au as keyof typeof DEG_PER];
        }
        if (single && quantity === 'length') return tk.v * MM_PER[units().length];
        if (single && quantity === 'angle') return tk.v * DEG_PER[units().angle];
        return tk.v;
      }
      if (tk.t === 'id') {
        const p = getDoc().params.find((x) => x.name === tk.v);
        if (!p) return fail(`Unknown parameter "${tk.v}"`);
        if (stack.includes(p.name)) return fail(`${p.name} uses itself`);
        const r = evalExpr(p.expr, p.quantity, [...stack, p.name]);
        if (!r.ok) return fail(`${p.name}: ${r.error}`);
        uses.push(p.name);
        return r.value;
      }
      return fail(`Unexpected "${tk.v}"`);
    };
    const product = (): number => {
      let v = primary();
      for (;;) {
        const tk = toks[pos];
        if (tk?.t === 'op' && (tk.v === '*' || tk.v === '/')) {
          pos++;
          const r = primary();
          v = tk.v === '*' ? v * r : v / r;
        } else return v;
      }
    };
    const sum = (): number => {
      let v = product();
      for (;;) {
        const tk = toks[pos];
        if (tk?.t === 'op' && (tk.v === '+' || tk.v === '-')) {
          pos++;
          const r = product();
          v = tk.v === '+' ? v + r : v - r;
        } else return v;
      }
    };
    try {
      const value = sum();
      if (pos < toks.length) return { ok: false, error: `Unexpected "${String(toks[pos].v)}"` };
      if (!Number.isFinite(value)) return { ok: false, error: 'The value is not a finite number' };
      return { ok: true, value, quantity, uses };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  return {
    units,
    evaluate: (text, quantity) => evalExpr(text, quantity, []),
    format: (value, quantity) => formatQuantity(value, quantity, units()),
    unitLabel: (q) => (q === 'length' ? units().length : q === 'angle' ? (units().angle === 'deg' ? '°' : 'rad') : ''),
  };
}

// ---------------------------------------------------------------- feature types

const EXTRUDE_ICON = 'M3 16l9 4.5 9-4.5-9-4.5z';
const SKETCH_ICON = 'M6 6v12';

function positiveProblem(units: UnitsService, label: string, e: string): string | null {
  const r = units.evaluate(e, 'length');
  if (!r.ok) return `${label}: ${r.error}`;
  if (!(r.value > 0)) return `${label}: must be greater than 0`;
  return null;
}

/** A stand-in for Extrude: a body of 10 x 20 x its distance (default 30 mm: 6000 mm³). */
function extrudeDef(startIncomplete = false): FeatureTypeDef<ExtrudeFeature> {
  return {
    type: 'extrude',
    label: 'Extrude',
    icon: EXTRUDE_ICON,
    create: (doc, init) => ({
      id: newId('f'),
      type: 'extrude',
      name: nextName('Extrude', doc.features.map((f) => f.name)),
      op: 'new',
      creates: newId('b'),
      scope: [],
      profiles: [],
      extent: { kind: 'blind', distance: startIncomplete ? '' : '30 mm' },
      flip: false,
      ...init,
    }),
    resolve: () => ({ ok: true, values: null }),
    incomplete: (f, units) => positiveProblem(units, 'Distance', f.extent.distance),
    parents: () => [],
    build: async () => ({ ok: false, message: 'fake' }),
  };
}

/** A stand-in for Sketch: makes no body. */
function sketchDef(): FeatureTypeDef<SketchFeature> {
  return {
    type: 'sketch',
    label: 'Sketch',
    icon: SKETCH_ICON,
    create: (doc, init) => ({
      id: newId('f'),
      type: 'sketch',
      name: nextName('Sketch', doc.features.map((f) => f.name)),
      support: { kind: 'plane', plane: 'origin:top' },
      plane: { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] },
      points: {},
      entities: [],
      constraints: [],
      solved: { values: {}, dof: 0, state: 'fully' },
      ...init,
    }),
    resolve: () => ({ ok: true, values: null }),
    incomplete: () => null,
    parents: () => [],
    build: async () => ({ ok: false, message: 'fake' }),
  };
}

/** The plain panel for the stand-in types (makeServices({ panels: true })). */
export const TEST_PANELS: CadModule = { id: 'test-panels', panels: { extrude: TestFeaturePanel, sketch: TestFeaturePanel } };

// ---------------------------------------------------------------- the fake service

export interface FakeDoc extends DocService {
  /** Every method call, in order ("rename f_x Box 9"). */
  readonly calls: string[];
  /** Force a feature's rebuild status (error / warning). */
  setStatus(id: FeatureId, st: FeatureStatus | null): void;
  /** Set the autosave state. */
  setSave(save: DocState['save']): void;
  /** Add a finished feature directly (not an undo step). */
  seed(type: FeatureType, patch?: Partial<Feature>): Feature;
}

function volumeOf(f: Feature, units: UnitsService): number {
  const v = (e: string) => {
    const r = units.evaluate(e, 'length');
    return r.ok ? r.value : 0;
  };
  return f.type === 'extrude' ? 10 * 20 * v(f.extent.distance) : 0;
}

export function createFakeDoc(opts: { units?: DocUnits; status?: DocState['status']; types?: FeatureType[]; incompleteExtrude?: boolean } = {}): FakeDoc {
  const calls: string[] = [];
  const overrides = new Map<FeatureId, FeatureStatus>();
  const emptyDoc: CadDoc = {
    schema: 2,
    units: opts.units ?? { length: 'mm', angle: 'deg' },
    params: [],
    bodies: {},
    features: [],
    meta: { created_at: '2026-09-30T00:00:00Z', written_by: 'test' },
  };
  const emptyView: CadView = { rollback: null, hiddenBodies: [], expanded: ['origin'] };
  const state = createStateStore<DocState>({
    status: opts.status ?? 'ready',
    error: null,
    doc: emptyDoc,
    view: emptyView,
    rebuild: { status: 'idle', seq: 0, features: {}, bodies: [], outputs: {}, ms: null, message: null },
    save: { state: 'saved', at: null },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    session: null,
  });
  const units = createFakeUnits(() => state.get().doc);
  const defs = new Map<FeatureType, FeatureTypeDef>();
  const registry: FeatureRegistry = {
    register(def) {
      defs.set(def.type, def as unknown as FeatureTypeDef);
    },
    get: (t) => defs.get(t),
    all: () => [...defs.values()],
  };
  const types = opts.types ?? ['extrude', 'sketch'];
  if (types.includes('extrude')) registry.register(extrudeDef(opts.incompleteExtrude));
  if (types.includes('sketch')) registry.register(sketchDef());

  const undoStack: { label: string; before: CadDoc; after: CadDoc }[] = [];
  const redoStack: typeof undoStack = [];
  const history = () => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.at(-1)?.label ?? null,
    redoLabel: redoStack.at(-1)?.label ?? null,
  });

  function rebuild() {
    const s = state.get();
    const n = s.doc.features.length;
    const bar = s.view.rollback == null ? n : s.view.rollback;
    const features: Record<FeatureId, FeatureStatus> = {};
    const bodies: BodyInfo[] = [];
    s.doc.features.forEach((f, i) => {
      if (i >= bar) {
        features[f.id] = { state: 'rolled-back' };
        return;
      }
      const bodiesBefore = bodies.length;
      if (f.suppressed) {
        features[f.id] = { state: 'suppressed', bodiesBefore };
        return;
      }
      const o = overrides.get(f.id);
      features[f.id] = { ...(o ?? { state: 'ok' }), bodiesBefore };
      if (o?.state === 'error') return;
      if ('op' in f && 'creates' in f && f.op === 'new' && f.creates) {
        const b = s.doc.bodies[f.creates];
        bodies.push({
          id: f.creates,
          name: b?.name ?? 'Body',
          color: b?.color ?? '#bdc9db',
          feature: f.id,
          shape: i + 1,
          valid: true,
          faces: 6,
          edges: 12,
          bbox: [0, 0, 0, 1, 1, 1] as never,
          volume: volumeOf(f, units),
          area: null,
          visible: !s.view.hiddenBodies.includes(f.creates),
          tessKey: `${f.id}:${JSON.stringify(f)}`,
          tess: null,
        } as BodyInfo);
      }
    });
    state.set((st) => ({ ...st, rebuild: { status: 'done', seq: st.rebuild.seq + 1, features, bodies, outputs: {}, ms: 1, message: null } }));
  }

  function withBody(doc: CadDoc, f: Feature): CadDoc {
    if (!('op' in f) || !('creates' in f) || f.op !== 'new' || !f.creates || doc.bodies[f.creates]) return doc;
    const name = nextName('Body', Object.values(doc.bodies).map((b) => b.name));
    return { ...doc, bodies: { ...doc.bodies, [f.creates]: { name, color: '#bdc9db' } } };
  }

  function commitDoc(next: CadDoc, label: string | null, before?: CadDoc) {
    const prev = before ?? state.get().doc;
    if (label) {
      undoStack.push({ label, before: prev, after: next });
      redoStack.length = 0;
    }
    state.set((s) => ({ ...s, doc: next, history: history() }));
    rebuild();
  }

  let open: SessionImpl | null = null;
  const editable = (): true | string => {
    const s = state.get();
    if (s.status === 'loading') return 'The part is still loading';
    if (s.status === 'error') return s.error ?? 'The part could not be read';
    if (s.save.state === 'conflict') return 'Changed in another tab · Reload to keep editing';
    return true;
  };
  const settle = () => open?.commit();

  class SessionImpl implements EditSession {
    readonly id = newId('s');
    readonly feature: FeatureId;
    open = true;
    current: Feature;
    before: CadDoc;
    inDoc: boolean;
    constructor(
      f: Feature,
      readonly isNew: boolean,
    ) {
      this.feature = f.id;
      this.current = f;
      this.before = state.get().doc;
      this.inDoc = !isNew;
      if (isNew) this.apply();
    }
    get draft() {
      return this.current;
    }
    incomplete() {
      return defs.get(this.current.type)!.incomplete(this.current as never, units);
    }
    apply() {
      if (this.incomplete()) return;
      let doc = withBody(state.get().doc, this.current);
      if (this.inDoc) doc = { ...doc, features: doc.features.map((f) => (f.id === this.feature ? this.current : f)) };
      else {
        const at = state.get().view.rollback ?? doc.features.length;
        const features = [...doc.features];
        features.splice(at, 0, this.current);
        doc = { ...doc, features };
        this.inDoc = true;
      }
      commitDoc(doc, null);
    }
    update(patch: Partial<Feature>) {
      calls.push(`update ${Object.keys(patch).join(',')}`);
      if (!this.open) return;
      this.current = { ...this.current, ...patch } as Feature;
      this.apply();
    }
    commit() {
      calls.push('commit');
      if (!this.open) return;
      if (this.isNew && (!this.inDoc || this.incomplete())) return this.discard();
      this.open = false;
      open = null;
      const doc = state.get().doc;
      if (doc !== this.before) {
        undoStack.push({ label: this.isNew ? this.current.name : `Edit ${this.current.name}`, before: this.before, after: doc });
        redoStack.length = 0;
      }
      state.set((s) => ({ ...s, session: null, history: history() }));
    }
    discard() {
      calls.push('discard');
      if (!this.open) return;
      this.open = false;
      open = null;
      state.set((s) => ({ ...s, session: null, doc: this.before }));
      rebuild();
    }
  }

  function edit(label: string, fn: (doc: CadDoc) => CadDoc | EditResult): EditResult {
    const e = editable();
    if (e !== true) return { ok: false, reason: e };
    settle();
    const r = fn(state.get().doc);
    if ('ok' in r) return r;
    commitDoc(r, label);
    return { ok: true };
  }

  const svc: FakeDoc = {
    calls,
    state,
    units,
    features: registry,
    async load() {
      calls.push('load');
      state.set({ status: 'ready' });
      rebuild();
    },
    editable,
    beginNew(type) {
      calls.push(`beginNew ${type}`);
      const e = editable();
      if (e !== true) throw new Error(e);
      settle();
      const f = defs.get(type)!.create(state.get().doc) as Feature;
      const s = new SessionImpl(f, true);
      open = s;
      state.set((st) => ({ ...st, session: { id: s.id, feature: s.feature, isNew: true } }));
      return s;
    },
    beginEdit(id) {
      calls.push(`beginEdit ${id}`);
      if (open && open.feature === id) return open;
      settle();
      const f = state.get().doc.features.find((x) => x.id === id);
      if (!f) throw new Error('That feature is not in the part');
      const s = new SessionImpl(f, false);
      open = s;
      state.set((st) => ({ ...st, session: { id: s.id, feature: id, isNew: false } }));
      return s;
    },
    session: () => open,
    rename(id, name) {
      calls.push(`rename ${id} ${name}`);
      return edit(`Rename`, (doc) => {
        const f = doc.features.find((x) => x.id === id);
        if (!f) return { ok: false, reason: 'That feature is not in the part' };
        return { ...doc, features: doc.features.map((x) => (x.id === id ? { ...x, name } : x)) };
      });
    },
    setSuppressed(id, suppressed) {
      calls.push(`setSuppressed ${id} ${suppressed}`);
      return edit(suppressed ? 'Suppress' : 'Unsuppress', (doc) => ({
        ...doc,
        features: doc.features.map((x) => (x.id === id ? ({ ...x, suppressed: suppressed || undefined } as Feature) : x)),
      }));
    },
    removeBlock(id) {
      const f = state.get().doc.features.find((x) => x.id === id);
      if (!f) return 'That feature is not in the part';
      return f.name === 'Locked' ? 'Extrude 2 uses Locked' : null;
    },
    remove(id) {
      calls.push(`remove ${id}`);
      if (open && open.feature === id && !this.removeBlock(id)) open.discard();
      return edit('Delete', (doc) => {
        const f = doc.features.find((x) => x.id === id);
        if (!f) return { ok: false, reason: 'That feature is not in the part' };
        if (f.name === 'Locked') return { ok: false, reason: 'Extrude 2 uses Locked' };
        return { ...doc, features: doc.features.filter((x) => x.id !== id) };
      });
    },
    move: () => ({ ok: false, reason: 'not in the fake' }),
    renameBody(id: BodyId, name) {
      calls.push(`renameBody ${id} ${name}`);
      return edit('Rename body', (doc) => ({ ...doc, bodies: { ...doc.bodies, [id]: { ...doc.bodies[id], name } } }));
    },
    setBodyColor: () => ({ ok: true }),
    addParam(p) {
      calls.push(`addParam ${p.name} ${p.expr} ${p.quantity}`);
      const e = editable();
      if (e !== true) return { ok: false, reason: e };
      const param: Param = { id: newId('p'), ...p };
      const doc = state.get().doc;
      commitDoc({ ...doc, params: [...doc.params, param] }, `Add parameter ${p.name}`);
      return param.id;
    },
    updateParam(id, patch) {
      calls.push(`updateParam ${id} ${JSON.stringify(patch)}`);
      return edit('Edit parameter', (doc) => {
        const next = doc.params.map((p) => (p.id === id ? { ...p, ...patch } : p));
        // A cycle check like the real one: every parameter must still evaluate.
        const probe = createFakeUnits(() => ({ units: doc.units, params: next }));
        for (const p of next) {
          const r = probe.evaluate(p.expr, p.quantity);
          if (!r.ok) return { ok: false, reason: r.error };
        }
        return { ...doc, params: next };
      });
    },
    removeParam(id) {
      calls.push(`removeParam ${id}`);
      return edit('Delete parameter', (doc) => {
        const p = doc.params.find((x) => x.id === id);
        if (!p) return { ok: false, reason: 'That parameter is not in the part' };
        const used = doc.features.find((f) => JSON.stringify(f).includes(p.name));
        if (used) return { ok: false, reason: `${p.name} can't be deleted: ${used.name} uses it` };
        const byParam = doc.params.find((q) => q.id !== id && new RegExp(`\\b${p.name}\\b`).test(q.expr));
        if (byParam) return { ok: false, reason: `${p.name} can't be deleted: ${byParam.name} uses it` };
        return { ...doc, params: doc.params.filter((x) => x.id !== id) };
      });
    },
    undo() {
      calls.push('undo');
      settle();
      const e = undoStack.pop();
      if (!e) return;
      redoStack.push(e);
      state.set((s) => ({ ...s, doc: e.before, history: history() }));
      rebuild();
    },
    redo() {
      calls.push('redo');
      const e = redoStack.pop();
      if (!e) return;
      undoStack.push(e);
      state.set((s) => ({ ...s, doc: e.after, history: history() }));
      rebuild();
    },
    repair(id) {
      calls.push(`repair ${id}`);
      return { ok: true };
    },
    retry(id) {
      calls.push(`retry ${id}`);
      return { ok: true };
    },
    setRollback(index) {
      calls.push(`setRollback ${index}`);
      settle();
      state.set((s) => ({ ...s, view: { ...s.view, rollback: index } }));
      rebuild();
    },
    setBodyVisible(id, visible) {
      calls.push(`setBodyVisible ${id} ${visible}`);
      state.set((s) => ({ ...s, view: { ...s.view, hiddenBodies: visible ? s.view.hiddenBodies.filter((b) => b !== id) : [...s.view.hiddenBodies, id] } }));
      rebuild();
    },
    setExpanded(key, expanded) {
      state.set((s) => {
        const has = s.view.expanded.includes(key);
        if (has === expanded) return s;
        return { ...s, view: { ...s.view, expanded: expanded ? [...s.view.expanded, key] : s.view.expanded.filter((k) => k !== key) } };
      });
    },
    async measure(id) {
      calls.push(`measure ${id}`);
      state.set((s) => ({ ...s, rebuild: { ...s.rebuild, bodies: s.rebuild.bodies.map((b) => (b.id === id ? { ...b, volume: 1000 } : b)) } }));
      return { volume: 1000, area: 600, centroid: null, bbox: [0, 0, 0, 10, 10, 10] as never, faces: 6, edges: 12, solids: 1 };
    },
    setPlanes(mode) {
      calls.push(`setPlanes ${mode}`);
      state.set((s) => ({ ...s, view: { ...s.view, planes: mode } }));
    },
    setCamera(camera) {
      calls.push('setCamera');
      state.set((s) => ({ ...s, view: { ...s.view, camera } }));
    },
    setSketchVisibility(id, mode) {
      calls.push(`setSketchVisibility ${id} ${mode}`);
      state.set((s) => ({ ...s, view: { ...s.view, sketches: { ...(s.view.sketches ?? {}), ...(mode ? { [id]: mode } : {}) } } }));
    },
    async flush() {},
    retrySave() {
      calls.push('retrySave');
      state.set((s) => ({ ...s, save: { state: 'saved', at: 'now' } }));
    },
    async reload() {
      calls.push('reload');
      state.set((s) => ({ ...s, save: { state: 'saved', at: 'now' } }));
    },
    dispose() {},
    setStatus(id, st) {
      if (st) overrides.set(id, st);
      else overrides.delete(id);
      rebuild();
    },
    setSave(save) {
      state.set({ save });
    },
    seed(type, patch) {
      const doc = state.get().doc;
      const f = { ...(defs.get(type)!.create(doc) as Feature), ...patch } as Feature;
      state.set((s) => ({ ...s, doc: { ...withBody(s.doc, f), features: [...s.doc.features, f] } }));
      rebuild();
      return f;
    },
  };
  return svc;
}

// ---------------------------------------------------------------- services

export interface TestServices {
  services: AppServices;
  doc: FakeDoc;
  kernelStatus: ReturnType<typeof createStateStore<KernelStatus>>;
  ws: ReturnType<typeof createFakeWorkspace>;
  flashes: unknown[][];
  looks: unknown[][];
}

export function makeServices(opts: { types?: FeatureType[]; status?: DocState['status']; units?: DocUnits; viewport?: boolean; incompleteExtrude?: boolean; panels?: boolean } = {}): TestServices {
  const ws = createFakeWorkspace();
  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const doc = createFakeDoc({ types: opts.types, status: opts.status, units: opts.units, incompleteExtrude: opts.incompleteExtrude });
  const kernelStatus = createStateStore<KernelStatus>({ state: 'ready', info: null, message: null, respawns: 0, busy: null, heap_bytes: null, memory_high: false });
  const kernel = {
    status: kernelStatus,
    start: async () => ({ occt: '7.9.3', variant: 'wasm32', ready_ms: 1, init_ms: 1, heap_bytes: 1 }),
    call: async () => {
      throw new Error('no kernel in UI tests');
    },
    onRespawn: () => () => {},
    restart: async () => ({ occt: '7.9.3', variant: 'wasm32', ready_ms: 1, init_ms: 1, heap_bytes: 1 }),
    dispose() {},
  } as unknown as KernelAdapter;
  const flashes: unknown[][] = [];
  const looks: unknown[][] = [];
  const vpState = createStateStore<{ planes: 'auto' | 'always' }>({ planes: 'auto' });
  const handle = opts.viewport
    ? ({
        state: vpState,
        flash: (items: unknown[]) => flashes.push(items),
        lookAt: (...args: unknown[]) => looks.push(args),
        reframe: () => false,
        setPlanes: (planes: 'auto' | 'always') => vpState.set({ planes }),
      } as unknown as ViewportHandle)
    : null;
  let services: AppServices | null = null;
  const commands = createCommandRegistry(() => services!);
  const keyboard = createKeyboard(document);
  services = {
    bridge,
    bus,
    commands,
    keyboard,
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle }),
    modules: createModuleRegistry(opts.panels ? [TEST_PANELS] : []),
    apis: createStateStore<AreaApis>({ sketch: null, solver: null, files: null }),
  };
  return { services, doc, kernelStatus, ws, flashes, looks };
}

export { bindCommandShortcuts };
