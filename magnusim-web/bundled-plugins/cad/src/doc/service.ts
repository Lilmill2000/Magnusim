// The document service: the one owner of the model. Loading (DocStore),
// edits (each one undo step), panel sessions (live apply, one undo step per
// session), rebuild (RebuildEngine), autosave, conflicts, view state.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import type { EventBus } from '../lib/bus';
import { newId, nextName } from '../lib/ids';
import { commitPendingEdits, pendingEditLabel, pendingEdits, subscribePendingEdits } from '../lib/pendingEdits';
import { createStateStore } from '../lib/store';
import { FEATURE_ACTION_LABELS, type BodyDef, type BodyId, type BodyMaking, type CadDoc, type CadView, type Feature, type FeatureId, type FeatureStatus, type FeatureType, type Param, type ParamId, type SavedCamera } from '../types/doc';
import type { BodyProps, DocService, DocState, EditResult, EditSession, FeatureFiles, SaveState } from '../types/doc-service';
import type { DocStore } from '../types/docstore';
import type { CadEvents } from '../types/events';
import type { BodyInfo, KernelAdapter } from '../types/kernel';
import type { SketchSolverClient } from '../types/sketch';
import type { Quantity } from '../types/units';
import { Autosave } from './autosave';
import { renameInExpr } from './expr';
import { REPAIR_FUZZY_STEPS } from './features/body-op';
import { storedBodyName } from './features/body-ids';
import { dependencies as featureDependencies, featureUses, gcBodies as gcFeatureBodies, isBodyMaking, ownsBody, renameParamInFeature, withNewBodies } from './features/hooks';
import { createBuiltinRegistry } from './features/registry';
import { createParamScope, featureExprs, paramNameProblem, usersOfParam } from './params';
import { RebuildEngine, type RebuildOutput } from './rebuild';
import { COLOR_RE, DEFAULT_BODY_COLOR, deepFreeze, emptyDoc, emptyView, PLUGIN_VERSION, readCamera, readView } from './schema';
import { openDocStore } from './store/open';
import { isRemovedFeature } from './features/removed';
import { createUndoStack } from './undo';
import { SourceRecord } from './source-record';
import { createUnitsService } from './units';

export interface DocServiceOptions {
  bridge: Bridge;
  kernel: KernelAdapter;
  bus: EventBus<CadEvents>;
  /** Autosave: sustained spacing of writes once the burst is used (ms); 1.5 s in the app (P0 gate 10). Tests pass less. */
  saveIntervalMs?: number;
  /** Autosave: writes allowed back to back (doc/autosave.ts SAVE_BURST). */
  saveBurst?: number;
  /** Autosave: spacing of view-only writes (doc/autosave.ts VIEW_INTERVAL_MS). Tests pass less. */
  saveViewIntervalMs?: number;
  log?: (message: string, detail?: unknown) => void;
  /** The sketch solver, once sketch mode's module started it (rebuilds re-solve sketches whose dimensions changed). */
  solver?: () => SketchSolverClient | null;
  /**
   * Calls fn whenever what solver() answers may have changed (bootstrap: the apis store).
   * When the solver starts after the Part was built, the part rebuilds, so a sketch
   * shown with its stored shape ("the sketch solver is not running") is solved.
   */
  onSolverChange?: (fn: () => void) => () => void;
}

const MAX_NAME = 80;
const QUANTITIES: Quantity[] = ['length', 'angle', 'scalar'];

type BodyFeature = Feature & BodyMaking;

function replaceFeature(doc: CadDoc, f: Feature): CadDoc {
  return { ...doc, features: doc.features.map((g) => (g.id === f.id ? f : g)) };
}

function clampView(view: CadView, doc: CadDoc): CadView {
  const n = doc.features.length;
  const rollback = view.rollback == null || view.rollback >= n ? null : Math.max(0, view.rollback);
  return rollback === view.rollback ? view : { ...view, rollback };
}

/**
 * The rollback bar after undo or redo replaced the features: it stays just
 * above the first feature it was above (or, when that one is gone, just below
 * the last one it was below). Undoing a feature inserted at the bar leaves the
 * features after it rolled back, as they were (review round 2: the bar jumped
 * to the end and brought them back).
 */
function keepBar(view: CadView, before: CadDoc, after: CadDoc): CadView {
  const r = view.rollback;
  if (r == null || r >= before.features.length) return clampView(view, after);
  const ids = after.features.map((f) => f.id);
  let next: number | null = null;
  for (let i = r; i < before.features.length && next == null; i++) {
    const at = ids.indexOf(before.features[i].id);
    if (at >= 0) next = at;
  }
  for (let i = r - 1; i >= 0 && next == null; i--) {
    const at = ids.indexOf(before.features[i].id);
    if (at >= 0) next = at + 1;
  }
  if (next == null) next = Math.min(r, ids.length);
  return clampView(next === r ? view : { ...view, rollback: next }, after);
}

function stamp(doc: CadDoc): CadDoc {
  return doc.meta.written_by === PLUGIN_VERSION ? doc : { ...doc, meta: { ...doc.meta, written_by: PLUGIN_VERSION } };
}

export function createDocService(opts: DocServiceOptions): DocService {
  const { bridge, kernel, bus } = opts;
  const log = opts.log ?? ((m: string, d?: unknown) => console.warn(`[cad] ${m}`, d ?? ''));
  const registry = createBuiltinRegistry();
  const sessionTag = newId('s');
  const undo = createUndoStack<CadDoc>();
  const dependencies = (doc: CadDoc, f: Feature) => featureDependencies(registry, doc, f);
  const gcBodies = (doc: CadDoc) => gcFeatureBodies(registry, doc);

  const state = createStateStore<DocState>({
    status: 'loading',
    error: null,
    doc: deepFreeze(emptyDoc(bridge.units())),
    view: emptyView(),
    rebuild: { status: 'idle', seq: 0, features: {}, bodies: [], outputs: {}, ms: null, message: null },
    save: { state: 'saved', at: null },
    history: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    session: null,
    sourceVersion: 0,
  });
  // LINK: the save counter goes into the study record after each save (at most one write per 1.5 s).
  const record = new SourceRecord({
    study: bridge.study,
    log,
    // Only while a geometry is linked: before that no row shows it (and a host before 1.5 has none).
    linked: async () => !!bridge.link && (await bridge.link.linkedGeometry()) !== null,
  });
  const units = createUnitsService(
    () => state.get().doc.units,
    () => state.get().doc.params,
  );

  let store: DocStore | null = null;
  let autosave: Autosave | null = null;
  let studyRev = bridge.context.study.rev;
  let loadSeq = 0;
  let disposed = false;
  let open: SessionImpl | null = null;

  // Feature builds read stored files (an import's healed BREP) through ws.files, checked against their sha256.
  const files: FeatureFiles | null = bridge.files
    ? {
        async read(ref) {
          const buf = await bridge.files!.read(ref.rel);
          if (!buf) return null;
          if (ref.sha256 && typeof crypto !== 'undefined' && crypto.subtle) {
            const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
            if (hex !== ref.sha256.toLowerCase()) throw new Error(`the stored file ${ref.rel} changed (its checksum is not the one the Part recorded)`);
          }
          return buf;
        },
      }
    : null;

  const engine = new RebuildEngine({
    kernel,
    registry,
    files,
    solver: () => opts.solver?.() ?? null,
    onStart() {
      state.set((s) => (s.rebuild.status === 'running' ? s : { ...s, rebuild: { ...s.rebuild, status: 'running' } }));
    },
    onResult(out: RebuildOutput) {
      let seq = 0;
      state.set((s) => {
        seq = s.rebuild.seq + 1;
        const hidden = new Set(s.view.hiddenBodies);
        const bodies = out.bodies.map((b) => (b.visible === !hidden.has(b.id) ? b : { ...b, visible: !hidden.has(b.id) }));
        return { ...s, rebuild: { status: out.message ? 'failed' : 'done', seq, features: out.features, bodies, outputs: out.outputs, ms: out.ms, message: out.message } };
      });
      bus.emit('doc:rebuilt', { seq, ms: out.ms, failed: out.failed });
    },
    onRespawn(reason) {
      bus.emit('kernel:respawned', { reason, count: kernel.status.get().respawns });
    },
  });

  /**
   * The view the rebuild uses: the saved one, except while a session edits a
   * feature whose type isolates while editing (a sketch): then the rebuild
   * stops just after it (later features show rolled back; nothing downstream
   * rebuilds on every edit). Never saved.
   */
  function rebuildView(s: DocState): CadView {
    if (!open || !open.open) return s.view;
    const def = registry.get(open.draft.type);
    if (!def?.isolateWhileEditing) return s.view;
    const at = s.doc.features.findIndex((f) => f.id === open!.feature);
    if (at < 0) return s.view;
    const stop = at + 1;
    if (s.view.rollback != null && s.view.rollback <= stop) return s.view;
    return { ...s.view, rollback: stop >= s.doc.features.length ? null : stop };
  }

  function rebuild() {
    const s = state.get();
    if (s.status !== 'ready') return;
    engine.request({ doc: s.doc, view: rebuildView(s) });
  }

  let solverRuns = !!opts.solver?.();
  const offSolver =
    opts.onSolverChange?.(() => {
      const now = !!opts.solver?.();
      if (now === solverRuns) return;
      solverRuns = now;
      if (now) rebuild();
    }) ?? (() => {});

  function historyState(): DocState['history'] {
    return { canUndo: undo.canUndo, canRedo: undo.canRedo, undoLabel: undo.undoLabel, redoLabel: undo.redoLabel };
  }

  /** Put a new model in place: optional undo step, save, rebuild. */
  function applyDoc(next: CadDoc, label: string | null, before?: CadDoc) {
    const prev = before ?? state.get().doc;
    if (next === state.get().doc && !label) return;
    const doc = deepFreeze(stamp(next));
    if (label && doc !== prev) undo.push({ label, before: prev, after: doc });
    state.set((s) => ({ ...s, doc, view: clampView(s.view, doc), history: historyState() }));
    autosave?.modelChanged();
    rebuild();
  }

  function setView(next: CadView, opts2: { rebuild?: boolean } = {}) {
    const s = state.get();
    if (next === s.view) return;
    state.set((st) => {
      let rb = st.rebuild;
      const hidden = new Set(next.hiddenBodies);
      if (rb.bodies.some((b) => b.visible === hidden.has(b.id))) {
        rb = { ...rb, bodies: rb.bodies.map((b) => (b.visible === !hidden.has(b.id) ? b : { ...b, visible: !hidden.has(b.id) })) };
      }
      return { ...st, view: next, rebuild: rb };
    });
    autosave?.viewChanged();
    if (opts2.rebuild) rebuild();
  }

  function editable(): true | string {
    const s = state.get();
    if (s.status === 'loading') return 'The part is still loading';
    if (s.status === 'error') return s.error ?? 'The part could not be read';
    if (s.save.state === 'conflict') return 'Changed in another tab · Reload to keep editing';
    if (s.save.state === 'updated') return 'Updated in another tab · Reload to keep editing';
    return true;
  }

  function refuse(): EditResult | null {
    const ok = editable();
    return ok === true ? null : { ok: false, reason: ok };
  }

  function featureById(id: FeatureId): Feature | undefined {
    return state.get().doc.features.find((f) => f.id === id);
  }

  /** Close an open session (Done) before any other edit, so undo steps stay in order. */
  function settle() {
    if (open) open.commit();
  }

  // ------------------------------------------------------------------ sessions

  class SessionImpl implements EditSession {
    readonly id = newId('s');
    readonly feature: FeatureId;
    open = true;
    private current: Feature;
    /** The document when the session opened (a refused Delete checks it too). */
    readonly before: CadDoc;
    private readonly viewBefore: CadView;
    private inDoc: boolean;
    private lastCreates: BodyId | null;

    constructor(
      draft: Feature,
      readonly isNew: boolean,
      private readonly insertAt: number,
    ) {
      this.feature = draft.id;
      this.current = draft;
      this.before = state.get().doc;
      this.viewBefore = state.get().view;
      this.inDoc = !isNew;
      this.lastCreates = isBodyMaking(draft) ? draft.creates : null;
      // The open session from the start: its first apply already rebuilds as this session (isolateWhileEditing).
      open = this;
      if (isNew) this.apply();
      else if (this.def()?.isolateWhileEditing) rebuild();
    }

    get changed(): boolean {
      if (!this.open) return false;
      const doc = gcBodies(state.get().doc);
      return doc !== this.before && JSON.stringify(doc) !== JSON.stringify(this.before);
    }

    /** The rebuild stops after this feature while it is edited (FeatureTypeDef.isolateWhileEditing). */
    private isolates(): boolean {
      return !!this.def()?.isolateWhileEditing;
    }

    get draft(): Feature {
      return this.current;
    }

    private def() {
      return registry.get(this.current.type);
    }

    incomplete(): string | null {
      const def = this.def();
      if (!def) return `This version of Magnusim CAD cannot edit "${this.current.type}" features`;
      return def.incomplete(this.current, units);
    }

    /** Put the draft in the document when it validates (live apply). */
    private apply() {
      if (this.incomplete() !== null) return;
      let doc = state.get().doc;
      let f = this.current;
      if (isBodyMaking(f) && f.op === 'new') {
        let creates = f.creates ?? this.lastCreates;
        if (!creates) creates = newId('b');
        this.lastCreates = creates;
        if (!doc.bodies[creates]) {
          const name = nextName('Body', Object.values(doc.bodies).map((b) => b.name));
          doc = { ...doc, bodies: { ...doc.bodies, [creates]: { name, color: DEFAULT_BODY_COLOR } } };
        }
        if (f.creates !== creates) f = { ...f, creates } as Feature;
        this.current = f;
      }
      // Bodies the feature brings with their names and colours (an import's STEP bodies).
      doc = withNewBodies(registry, doc, f);
      if (this.inDoc) {
        doc = replaceFeature(doc, f);
      } else {
        const features = [...doc.features];
        features.splice(this.insertAt, 0, f);
        doc = { ...doc, features };
        this.inDoc = true;
        const v = state.get().view;
        // Inserted at the rollback bar: the bar moves below the new feature.
        if (v.rollback != null && v.rollback >= this.insertAt) setView({ ...v, rollback: v.rollback + 1 });
      }
      applyDoc(doc, null);
      state.set((s) => (s.session && s.session.id === this.id ? s : { ...s, session: { id: this.id, feature: this.feature, isNew: this.isNew } }));
    }

    update(patch: Partial<Feature>): void {
      if (!this.open || editable() !== true) return;
      const { id: _id, type: _type, ...rest } = patch as Partial<Feature> & Record<string, unknown>;
      let next = { ...this.current, ...rest } as Feature;
      if (isBodyMaking(next) && 'op' in rest) {
        if (next.op !== 'new' && next.creates) {
          this.lastCreates = next.creates;
          next = { ...next, creates: null } as Feature;
        } else if (next.op === 'new' && !next.creates) {
          next = { ...next, creates: this.lastCreates } as Feature;
        }
        // A new body is made from nothing: it has no targets.
        if ((next as BodyFeature).op === 'new' && (next as BodyFeature).scope.length) next = { ...next, scope: [] } as Feature;
      }
      this.current = next;
      this.apply();
    }

    commit(): void {
      if (!this.open) return;
      if (this.isNew && (!this.inDoc || this.incomplete() !== null)) {
        this.discard();
        return;
      }
      this.open = false;
      open = null;
      const doc = gcBodies(state.get().doc);
      const f = featureById(this.feature);
      const label = this.isNew ? (f?.name ?? 'New feature') : `Edit ${f?.name ?? 'feature'}`;
      if (doc !== this.before) {
        // One undo step for the whole session; none when it ended where it began
        // (20 mm typed to 1e6 and back): an Undo that changes nothing is confusing.
        if (JSON.stringify(doc) === JSON.stringify(this.before)) applyDoc(this.before, null);
        else applyDoc(doc, label, this.before);
      } else if (this.isolates()) {
        // Nothing changed, but the rebuild stopped after this feature while it was edited.
        rebuild();
      }
      state.set((s) => ({ ...s, session: null, history: historyState() }));
    }

    discard(): void {
      if (!this.open) return;
      this.open = false;
      open = null;
      if (state.get().doc !== this.before) applyDoc(this.before, null);
      else if (this.isolates()) rebuild();
      if (this.isNew && state.get().view.rollback !== this.viewBefore.rollback) setView({ ...state.get().view, rollback: this.viewBefore.rollback }, { rebuild: true });
      state.set((s) => ({ ...s, session: null }));
    }
  }

  // ------------------------------------------------------------------ edits

  function beginNew(type: FeatureType, init?: Partial<Feature>): EditSession {
    const ok = editable();
    if (ok !== true) throw new Error(ok);
    const def = registry.get(type);
    if (!def) throw new Error(`Unknown feature type "${type}"`);
    settle();
    const doc = state.get().doc;
    const draft = def.create(doc, init as never);
    const at = state.get().view.rollback ?? doc.features.length;
    const s = new SessionImpl(draft, true, at);
    open = s;
    state.set((st) => ({ ...st, session: { id: s.id, feature: s.feature, isNew: true } }));
    return s;
  }

  function beginEdit(id: FeatureId): EditSession {
    const ok = editable();
    if (ok !== true) throw new Error(ok);
    if (open && open.feature === id) return open;
    settle();
    const f = featureById(id);
    if (!f) throw new Error('That feature is not in the part');
    const at = state.get().doc.features.indexOf(f);
    open = new SessionImpl(f, false, at);
    state.set((s) => ({ ...s, session: { id: open!.id, feature: id, isNew: false } }));
    return open;
  }

  /** One undoable edit of the model: settle the session, refuse when not editable, apply. */
  function edit(fn: (doc: CadDoc) => { doc: CadDoc; label: string } | EditResult): EditResult {
    const no = refuse();
    if (no) return no;
    settle();
    const r = fn(state.get().doc);
    if ('ok' in r) return r;
    if (r.doc !== state.get().doc) applyDoc(r.doc, r.label);
    return { ok: true };
  }

  function rename(id: FeatureId, raw: string): EditResult {
    return edit((doc) => {
      const f = doc.features.find((g) => g.id === id);
      if (!f) return { ok: false, reason: 'That feature is not in the part' };
      const name = String(raw ?? '').trim();
      if (!name) return { ok: false, reason: 'Enter a name' };
      if (name.length > MAX_NAME) return { ok: false, reason: `A name can have at most ${MAX_NAME} characters` };
      if (name === f.name) return { doc, label: '' };
      const clash = doc.features.find((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase());
      if (clash) return { ok: false, reason: `Another feature is already called ${clash.name}` };
      return { doc: replaceFeature(doc, { ...f, name }), label: `Rename ${f.name}` };
    });
  }

  function setSuppressed(id: FeatureId, suppressed: boolean): EditResult {
    return edit((doc) => {
      const f = doc.features.find((g) => g.id === id);
      if (!f) return { ok: false, reason: 'That feature is not in the part' };
      if (!!f.suppressed === suppressed) return { doc, label: '' };
      const next = { ...f } as Feature;
      if (suppressed) next.suppressed = true;
      else delete next.suppressed;
      return { doc: replaceFeature(doc, next), label: `${suppressed ? 'Suppress' : 'Unsuppress'} ${f.name}` };
    });
  }

  function suppressRemoved(): EditResult {
    return edit((doc) => {
      const gone = doc.features.filter((f) => isRemovedFeature(f) && !f.suppressed);
      if (!gone.length) return { doc, label: '' };
      const ids = new Set(gone.map((f) => f.id));
      const features = doc.features.map((f) => (ids.has(f.id) ? ({ ...f, suppressed: true } as Feature) : f));
      // One undo step for all of them (Undo brings every one back).
      return { doc: { ...doc, features }, label: gone.length === 1 ? `Suppress ${gone[0].name}` : 'Suppress the removed features' };
    });
  }

  function dependents(doc: CadDoc, f: Feature): Feature[] {
    return doc.features.filter((g) => g.id !== f.id && dependencies(doc, g).includes(f.id));
  }

  /** A body made by `f` that `d` uses, for "Combine 1 uses Body 2 of Split 1" (or null). */
  function bodyLink(doc: CadDoc, f: Feature, d: Feature): BodyId | null {
    const uses = featureUses(registry, d);
    if (uses === 'all') return null;
    return uses.find((b) => ownsBody(registry, f, b)) ?? null;
  }

  /** Why `f` cannot be removed from `doc` (a later feature uses it), or null. */
  function usedBy(doc: CadDoc, f: Feature): string | null {
    const deps = dependents(doc, f);
    if (!deps.length) return null;
    const d = deps[0];
    const via = bodyLink(doc, f, d);
    const body = via ? (storedBodyName(doc, via) ?? 'the body') : null;
    // A body named as its feature (Enclosure 1's body "Enclosure 1") is named once (SD review round 2).
    const what = body && body !== f.name ? `${body} of ${f.name}` : f.name;
    return `${d.name} uses ${what}: delete ${d.name} or change what it uses first`;
  }

  function removeBlock(id: FeatureId): string | null {
    const doc = state.get().doc;
    const f = doc.features.find((g) => g.id === id);
    if (!f) return 'That feature is not in the part';
    const now = usedBy(doc, f);
    if (now) return now;
    // Delete removes the feature as it was before its panel opened: check that one too.
    if (open && open.open && open.feature === id && !open.isNew) {
      const was = open.before.features.find((g) => g.id === id);
      if (was) return usedBy({ ...doc, features: doc.features.map((g) => (g.id === id ? was : g)) }, was);
    }
    return null;
  }

  function remove(id: FeatureId): EditResult {
    const no = refuse();
    if (no) return no;
    // Refused before anything changes: an open panel session on it keeps its work
    // (review P2/P3 round 1: a refused Delete threw away the edits of the open sketch).
    const block = removeBlock(id);
    if (block) return { ok: false, reason: block };
    if (open && open.feature === id) open.discard();
    return edit((doc) => {
      const idx = doc.features.findIndex((g) => g.id === id);
      if (idx < 0) return { ok: false, reason: 'That feature is not in the part' };
      const f = doc.features[idx];
      const used = usedBy(doc, f);
      if (used) return { ok: false, reason: used };
      const features = doc.features.filter((g) => g.id !== id);
      const next = gcBodies({ ...doc, features });
      const v = state.get().view;
      const gone = Object.keys(doc.bodies).filter((b) => !next.bodies[b]);
      if ((v.rollback != null && idx < v.rollback) || gone.some((b) => v.hiddenBodies.includes(b))) {
        setView({ ...v, rollback: v.rollback != null && idx < v.rollback ? v.rollback - 1 : v.rollback, hiddenBodies: v.hiddenBodies.filter((b) => !gone.includes(b)) });
      }
      return { doc: next, label: `Delete ${f.name}` };
    });
  }

  function move(id: FeatureId, toIndex: number): EditResult {
    return edit((doc) => {
      const from = doc.features.findIndex((g) => g.id === id);
      if (from < 0) return { ok: false, reason: 'That feature is not in the part' };
      const f = doc.features[from];
      const to = Math.max(0, Math.min(doc.features.length - 1, Math.floor(toIndex)));
      if (to === from) return { doc, label: '' };
      const deps = dependencies(doc, f);
      for (const p of deps) {
        const pi = doc.features.findIndex((g) => g.id === p);
        if (pi >= to && pi !== from) return { ok: false, reason: `${f.name} uses ${doc.features[pi].name}: it cannot move above it` };
      }
      for (const d of dependents(doc, f)) {
        const di = doc.features.indexOf(d);
        if (di <= to) return { ok: false, reason: `${d.name} uses ${f.name}: ${f.name} cannot move below it` };
      }
      const features = [...doc.features];
      features.splice(from, 1);
      features.splice(to, 0, f);
      return { doc: { ...doc, features }, label: `Move ${f.name}` };
    });
  }

  /**
   * A body's definition: the stored one, or (a derived body such as a split
   * piece, which has none until it is renamed or recoloured) the one the
   * rebuild shows, when a feature makes it.
   */
  function bodyDefOf(doc: CadDoc, id: BodyId): BodyDef | null {
    const b = doc.bodies[id];
    if (b) return b;
    const built = state.get().rebuild.bodies.find((x) => x.id === id);
    if (!built || !doc.features.some((f) => ownsBody(registry, f, id))) return null;
    return { name: built.name, color: built.color };
  }

  function renameBody(id: BodyId, raw: string): EditResult {
    return edit((doc) => {
      const b = bodyDefOf(doc, id);
      if (!b) return { ok: false, reason: 'That body is not in the part' };
      const name = String(raw ?? '').trim();
      if (!name) return { ok: false, reason: 'Enter a name' };
      if (name.length > MAX_NAME) return { ok: false, reason: `A name can have at most ${MAX_NAME} characters` };
      if (name === b.name) return { doc, label: '' };
      const clash = Object.entries(doc.bodies).find(([k, x]) => k !== id && x.name.toLowerCase() === name.toLowerCase());
      if (clash) return { ok: false, reason: `Another body is already called ${clash[1].name}` };
      return { doc: { ...doc, bodies: { ...doc.bodies, [id]: { ...b, name } } }, label: `Rename ${b.name}` };
    });
  }

  function setBodyColor(id: BodyId, raw: string): EditResult {
    return edit((doc) => {
      const b = bodyDefOf(doc, id);
      if (!b) return { ok: false, reason: 'That body is not in the part' };
      const color = String(raw ?? '').trim().toLowerCase();
      if (!COLOR_RE.test(color)) return { ok: false, reason: 'A colour is written #rrggbb' };
      if (color === b.color.toLowerCase()) return { doc, label: '' };
      return { doc: { ...doc, bodies: { ...doc.bodies, [id]: { ...b, color } } }, label: `Colour of ${b.name}` };
    });
  }

  function setBodyInSimulation(id: BodyId, include: boolean): EditResult {
    return edit((doc) => {
      const b = bodyDefOf(doc, id);
      if (!b) return { ok: false, reason: 'That body is not in the part' };
      if ((b.simulation !== false) === include) return { doc, label: '' };
      const next = { ...b };
      if (include) delete next.simulation;
      else next.simulation = false;
      return { doc: { ...doc, bodies: { ...doc.bodies, [id]: next } }, label: include ? `Include ${b.name} in the simulation` : `Leave ${b.name} out of the simulation` };
    });
  }

  function checkParam(params: readonly Param[], p: Param, docUnits: CadDoc['units']): string | null {
    const nameProblem = paramNameProblem(p.name, params, p.id);
    if (nameProblem) return nameProblem;
    if (!QUANTITIES.includes(p.quantity)) return 'Pick length, angle or number';
    const scope = createParamScope(params, docUnits);
    const r = scope.valueOf(p.name);
    if (!r || !r.ok) return r ? r.error : 'Not evaluated';
    return null;
  }

  function addParam(p: Omit<Param, 'id'>): ParamId | EditResult {
    const no = refuse();
    if (no) return no;
    settle();
    const doc = state.get().doc;
    const param: Param = { id: newId('p'), name: String(p.name ?? '').trim(), expr: String(p.expr ?? '').trim(), quantity: p.quantity ?? 'length' };
    if (p.comment) param.comment = String(p.comment);
    if (p.favorite) param.favorite = true;
    const params = [...doc.params, param];
    const problem = checkParam(params, param, doc.units);
    if (problem) return { ok: false, reason: problem };
    applyDoc({ ...doc, params }, `Add parameter ${param.name}`);
    return param.id;
  }

  function updateParam(id: ParamId, patch: Partial<Omit<Param, 'id'>>): EditResult {
    return edit((doc) => {
      const old = doc.params.find((p) => p.id === id);
      if (!old) return { ok: false, reason: 'That parameter is not in the part' };
      const next: Param = { ...old, ...patch, id } as Param;
      next.name = String(next.name ?? '').trim();
      next.expr = String(next.expr ?? '').trim();
      if (!next.comment) delete next.comment;
      if (!next.favorite) delete next.favorite;
      let params = doc.params.map((p) => (p.id === id ? next : p));
      let features = doc.features;
      if (next.name !== old.name) {
        // Rename every use: other parameters and every feature expression.
        params = params.map((p) => (p.id === id ? p : { ...p, expr: renameInExpr(p.expr, old.name, next.name) }));
        features = features.map((f) => {
          const exprs = featureExprs(f, registry);
          if (!exprs.some((e) => renameInExpr(e.expr, old.name, next.name) !== e.expr)) return f;
          return renameParamInFeature(registry, f, old.name, next.name);
        });
        next.expr = renameInExpr(next.expr, old.name, next.name);
      }
      const problem = checkParam(params, params.find((p) => p.id === id)!, doc.units);
      if (problem) return { ok: false, reason: problem };
      return { doc: { ...doc, params, features }, label: `Edit parameter ${next.name}` };
    });
  }

  function removeParam(id: ParamId): EditResult {
    return edit((doc) => {
      const p = doc.params.find((x) => x.id === id);
      if (!p) return { ok: false, reason: 'That parameter is not in the part' };
      const users = usersOfParam(doc, p.name, registry);
      const names = [...users.params.map((u) => u.name), ...users.features.map((u) => u.name)];
      if (names.length) return { ok: false, reason: `${p.name} can't be deleted: ${listOfNames(names)} ${names.length === 1 ? 'uses' : 'use'} it` };
      return { doc: { ...doc, params: doc.params.filter((x) => x.id !== id) }, label: `Delete parameter ${p.name}` };
    });
  }

  function doUndo(redo: boolean) {
    if (editable() !== true) return;
    settle();
    const before = state.get().doc;
    const target = redo ? undo.redo() : undo.undo();
    if (!target) return;
    const doc = target;
    const view = keepBar(state.get().view, before, doc);
    const moved = view !== state.get().view;
    state.set((s) => ({ ...s, doc, view, history: historyState() }));
    if (moved) autosave?.viewChanged();
    autosave?.modelChanged();
    rebuild();
  }

  function repair(id: FeatureId): EditResult {
    return edit((doc) => {
      const f = doc.features.find((g) => g.id === id);
      if (!f) return { ok: false, reason: 'That feature is not in the part' };
      const st: FeatureStatus | undefined = state.get().rebuild.features[id];
      // Any feature whose build offered "Try repair" (body-making features, combine, press-pull) keeps a `repair` field.
      if (!st?.actions?.includes('repair')) return { ok: false, reason: `${f.name} has nothing to repair` };
      const current = (f as Feature & { repair?: { fuzzy: number } }).repair?.fuzzy ?? 0;
      const next = REPAIR_FUZZY_STEPS.find((s) => s > current);
      if (!next) return { ok: false, reason: `${f.name} cannot be repaired further` };
      return { doc: replaceFeature(doc, { ...f, repair: { fuzzy: next } } as Feature), label: `${FEATURE_ACTION_LABELS.repair} ${f.name}` };
    });
  }

  function retry(id: FeatureId): EditResult {
    const f = featureById(id);
    if (!f) return { ok: false, reason: 'That feature is not in the part' };
    return engine.retry(id) ? { ok: true } : { ok: false, reason: `${f.name} was not stopped` };
  }

  function setRollback(index: number | null) {
    if (state.get().status !== 'ready') return;
    settle();
    const s = state.get();
    const n = s.doc.features.length;
    let r = index == null ? null : Math.max(0, Math.min(n, Math.floor(index)));
    if (r === n) r = null;
    if (r === s.view.rollback) return;
    setView({ ...s.view, rollback: r }, { rebuild: true });
  }

  function setBodyVisible(id: BodyId, visible: boolean) {
    const v = state.get().view;
    const has = v.hiddenBodies.includes(id);
    if (has === !visible) return;
    setView({ ...v, hiddenBodies: visible ? v.hiddenBodies.filter((b) => b !== id) : [...v.hiddenBodies, id] });
  }

  function setExpanded(key: string, expanded: boolean) {
    const v = state.get().view;
    const has = v.expanded.includes(key);
    if (has === expanded) return;
    setView({ ...v, expanded: expanded ? [...v.expanded, key] : v.expanded.filter((k) => k !== key) });
  }

  function setPlanes(mode: 'auto' | 'always') {
    const v = state.get().view;
    if (state.get().status !== 'ready' || (v.planes ?? 'auto') === mode) return;
    const next: CadView = { ...v };
    if (mode === 'always') next.planes = 'always';
    else delete next.planes;
    setView(next);
  }

  function setCamera(camera: SavedCamera) {
    const v = state.get().view;
    const c = readCamera(camera);
    if (state.get().status !== 'ready' || !c || JSON.stringify(v.camera ?? null) === JSON.stringify(c)) return;
    setView({ ...v, camera: c });
  }

  function setSketchVisibility(id: FeatureId, mode: 'shown' | 'hidden' | null) {
    const v = state.get().view;
    if (state.get().status !== 'ready' || (v.sketches?.[id] ?? null) === mode) return;
    const sketches = { ...(v.sketches ?? {}) };
    if (mode) sketches[id] = mode;
    else delete sketches[id];
    const next: CadView = { ...v, sketches };
    if (!Object.keys(sketches).length) delete next.sketches;
    setView(next);
  }

  async function measure(id: BodyId): Promise<BodyProps> {
    const p = await engine.measure(id);
    state.set((s) => {
      const i = s.rebuild.bodies.findIndex((b) => b.id === id);
      if (i < 0) return s;
      const b = s.rebuild.bodies[i];
      if (b.volume === p.volume && b.area === p.area && b.solids === p.solids) return s;
      const next: BodyInfo = { ...b, volume: p.volume, area: p.area, bbox: p.bbox, faces: p.faces, edges: p.edges, solids: p.solids };
      const bodies = [...s.rebuild.bodies];
      bodies[i] = next;
      return { ...s, rebuild: { ...s.rebuild, bodies } };
    });
    return p;
  }

  // ------------------------------------------------------------------ load / save

  async function load(): Promise<void> {
    const my = ++loadSeq;
    if (open) {
      open.open = false;
      open = null;
    }
    autosave?.dispose();
    autosave = null;
    state.set({ status: 'loading', error: null, session: null });
    try {
      for (let attempt = 0; ; attempt++) {
        const opened = await openDocStore(bridge, sessionTag, log);
        if (my !== loadSeq || disposed) return;
        studyRev = Math.max(studyRev, opened.rev);
        store = opened.store;
        if (opened.note) log(`the model ${opened.note}`);
        const model = await store.loadModel();
        const doc = deepFreeze(model ? model.doc : emptyDoc(bridge.units()));
        const view = readView(await store.loadView().catch(() => null), doc.features.length);
        if (my !== loadSeq || disposed) return;
        undo.clear();
        // The save counter never goes down: the file's, or the study record's when that is newer.
        const loadedVersion = Math.max(model ? model.sourceVersion : 0, Number(bridge.context.study?.source_version) || 0);
        const saver = new Autosave({
          store,
          etag: model ? model.etag : null,
          savedAt: model ? (model.savedAt ?? null) : null,
          sourceVersion: loadedVersion,
          onSaved: (v) => {
            if (autosave !== saver) return;
            state.set({ sourceVersion: v });
            record.saved(v);
          },
          getDoc: () => state.get().doc,
          getView: () => state.get().view,
          onState: (save) => {
            if (autosave === saver) state.set({ save });
          },
          intervalMs: opts.saveIntervalMs,
          burst: opts.saveBurst,
          viewIntervalMs: opts.saveViewIntervalMs,
          log,
        });
        autosave = saver;
        const pending: Record<FeatureId, FeatureStatus> = {};
        for (const f of doc.features) pending[f.id] = { state: 'pending' };
        state.set({
          status: 'ready',
          error: null,
          doc,
          view,
          save: { state: 'saved', at: model ? (model.savedAt ?? null) : null },
          history: historyState(),
          session: null,
          rebuild: { status: 'idle', seq: state.get().rebuild.seq, features: pending, bodies: [], outputs: {}, ms: null, message: null },
          sourceVersion: loadedVersion,
        });
        if (!model) {
          // A new Part is stored at once, so its units are fixed from now on.
          saver.modelChanged();
          await saver.flush();
          if (saver.conflicted && attempt === 0) {
            // Another tab created it at the same moment: read theirs.
            continue;
          }
        }
        rebuild();
        return;
      }
    } catch (e) {
      if (my !== loadSeq) return;
      const why = e instanceof Error ? e.message : String(e);
      log('the part could not be read', e);
      state.set({ status: 'error', error: `Could not read the part: ${why}` });
    }
  }

  const offStudy = bridge.onStudy((s) => {
    // A rename in the host header (or our own pointer write): adopt its rev silently.
    if (typeof s.rev === 'number') studyRev = s.rev;
  });

  // Leaving: write what waits at once. Back, Settings, Queue and the browser's
  // own controls are all outside the frame, so the pointer leaves it (or the
  // frame loses focus) before any of them is used (flushNow). F5, Ctrl+R,
  // Ctrl+W and the mouse's side Back / Forward buttons reach the frame
  // (leaveNow): on a 1.2 host that is the same conditional write, and while it
  // runs the page is dirty, so the host asks before it goes (setDirty above); on
  // a 1.1 host it posts the model in one message (review round 2).
  // A value typed in a panel field and not applied yet: the pointer leaving the
  // frame applies a whole one the user is not still typing (quiet: no refusal
  // shown); the leave keys apply it as Enter would; the frame losing focus and the
  // page going apply nothing, so the app's question ("Leaving discards them")
  // holds (lib/pendingEdits.ts; LINK polish of the SD final review).
  // A mouseleave with the pointer still over the frame is not the pointer leaving: the
  // app put something over the frame under a pointer that did not move (its leave
  // question after the browser's Back, its overlay), and the browser sent it then. It
  // applies nothing, so a leave already on its way never finds the typed text applied
  // and saved behind its question (Linux CI: the chip read "Saved" after Stay, where
  // "Not applied: press Enter" was right). A pointer that really leaves the frame is
  // outside it when the event is sent.
  const pointerLeft = (e: Event) => {
    if (!pointerOverFrame(e)) commitPendingEdits('quiet');
    autosave?.flushNow();
  };
  const saveNow = () => {
    autosave?.flushNow();
  };
  const leaveKey = () => {
    commitPendingEdits();
    autosave?.leaveNow();
  };
  const leaveNow = () => {
    autosave?.leaveNow();
  };
  const onLeaveKey = (e: KeyboardEvent) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === 'F5' || k === 'BrowserRefresh' || k === 'BrowserBack' || k === 'BrowserForward' || (ctrl && /^[rw]$/i.test(k)) || (ctrl && k === 'F4') || (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home'))) leaveKey();
  };
  // The mouse's side buttons (3 = Back, 4 = Forward): the browser goes back on
  // the release, with the pointer still over the part, so the press is the signal.
  const onSideButton = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) leaveKey();
  };
  // Back in this tab or window: another tab may have saved over the model meanwhile (UX review: the
  // overwritten tab still said "Saved").
  const checkStored = () => {
    void autosave?.checkStored();
  };
  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') leaveNow();
    else checkStored();
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', leaveNow);
    window.addEventListener('blur', saveNow);
    window.addEventListener('focus', checkStored);
    window.addEventListener('pointerdown', onSideButton, true);
    window.addEventListener('mousedown', onSideButton, true);
    window.addEventListener('mouseup', onSideButton, true);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    document.documentElement.addEventListener('mouseleave', pointerLeft);
    document.addEventListener('keydown', onLeaveKey, true);
  }

  // Unsaved work (host API 1.2, nav.setDirty): from the first change that is not
  // stored until it is (waiting on the budget, being written, refused, or
  // refused because another tab saved first), every way out of the workspace
  // asks "Leave without saving?" with this message after the plugin's name,
  // and F5 or closing the tab gets the browser's own prompt. The page never
  // reloads itself (a reload would clear the flag and lose the change).
  // A value typed in a panel field and not applied yet counts too
  // (lib/pendingEdits.ts): leaving applies it first, and the question asks only
  // when it is not saved by then; one the field refused says why.
  let toldDirty = '';
  const dirtyMessage = (s: DocState): string | null => {
    if (s.status !== 'ready') return null;
    const title = String(bridge.context.study?.title ?? '').trim() || 'this Part';
    const save: SaveState = s.save;
    if (save.state === 'error') return `Changes to ${title} are not saved: ${save.message}.`;
    if (save.state === 'conflict') return `Changes to ${title} are not saved: it was changed in another tab.`;
    const typed = pendingEdits();
    if (typed.refused) {
      // The reason after it when it fits the host's 200 characters.
      const head = `Changes to ${title} are not saved: the value typed in ${typed.refused.label} is not applied.`;
      const full = `${head} ${typed.refused.error.replace(/\.$/, '')}.`;
      return full.length <= 200 ? full : head;
    }
    // Typed and not applied (no Enter yet): say which field, so the question is true.
    const field = typed.pending ? pendingEditLabel() : null;
    if (field) return `Changes typed in ${field} of ${title} are not applied yet.`;
    if (save.state === 'pending' || save.state === 'saving' || typed.pending) return `Changes to ${title} are not saved yet.`;
    return null;
  };
  const syncDirty = () => {
    const msg = disposed ? null : dirtyMessage(state.get());
    const key = msg ?? '';
    if (key === toldDirty) return;
    toldDirty = key;
    bridge.setDirty(msg !== null, msg ?? undefined);
  };
  const offDirty = state.subscribe((s, prev) => {
    if (s.save !== prev.save || s.status !== prev.status) syncDirty();
  });
  const offTitle = bridge.onStudy(() => syncDirty());
  const offTyped = subscribePendingEdits(() => syncDirty());

  const service: DocService = {
    state,
    units,
    features: registry,
    load,
    editable,
    beginNew,
    beginEdit,
    session: () => open,
    rename,
    setSuppressed,
    suppressRemoved,
    remove,
    removeBlock,
    move,
    renameBody,
    setBodyColor,
    setBodyInSimulation,
    addParam,
    updateParam,
    removeParam,
    undo: () => doUndo(false),
    redo: () => doUndo(true),
    repair,
    retry,
    setRollback,
    setBodyVisible,
    setExpanded,
    setPlanes,
    setCamera,
    setSketchVisibility,
    measure,
    async flush() {
      await autosave?.flush();
    },
    async retellDirty() {
      const msg = disposed ? null : dirtyMessage(state.get());
      toldDirty = msg ?? '';
      await bridge.setDirtyNow(msg !== null, msg ?? undefined);
    },
    retrySave() {
      autosave?.retryNow();
    },
    holdSaves() {
      return autosave ? autosave.hold() : () => {};
    },
    async checkStored() {
      await autosave?.checkStored();
    },
    async reload() {
      await load();
    },
    async keepMine() {
      const saver = autosave;
      if (!saver || !saver.conflicted) return;
      await saver.keepMine();
    },
    async bodiesAtEnd() {
      const s = state.get();
      if (s.status !== 'ready') throw new Error(s.status === 'loading' ? 'the part is still loading' : (s.error ?? 'the part could not be read'));
      return engine.bodiesAtEnd(s.doc, s.view);
    },
    recordSettled: () => record.settled(),
    dispose() {
      if (disposed) return;
      disposed = true;
      offSolver();
      offStudy();
      offDirty();
      offTitle();
      offTyped();
      record.dispose();
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', leaveNow);
        window.removeEventListener('blur', saveNow);
        window.removeEventListener('focus', checkStored);
        window.removeEventListener('pointerdown', onSideButton, true);
        window.removeEventListener('mousedown', onSideButton, true);
        window.removeEventListener('mouseup', onSideButton, true);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
        document.documentElement.removeEventListener('mouseleave', pointerLeft);
        document.removeEventListener('keydown', onLeaveKey, true);
      }
      const saver = autosave;
      void saver?.flush().finally(() => saver.dispose());
      engine.dispose();
    },
  };
  // Tests and debugging only: the study rev the service holds.
  Object.defineProperty(service, 'studyRev', { get: () => studyRev, enumerable: false });
  return service;
}

/**
 * A mouse event whose pointer is inside the frame's viewport (something was put over
 * the frame under it): not the pointer leaving the frame.
 */
function pointerOverFrame(e: Event): boolean {
  if (typeof window === 'undefined' || !('clientX' in e)) return false;
  const { clientX: x, clientY: y } = e as MouseEvent;
  return x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
}

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
function listOfNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

