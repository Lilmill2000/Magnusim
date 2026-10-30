// The document service: the one owner of the model. Loading (DocStore),
// edits (each one undo step), panel sessions (live apply, one undo step per
// session), rebuild (RebuildEngine), autosave, conflicts, view state, and
// Assistant steps (doc.assistant: one edit call all or nothing, with the save
// hold, take-over, seal and restore; the person always comes first).
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import type { EventBus } from '../lib/bus';
import { newId, nextName } from '../lib/ids';
import { commitPendingEdits, pendingEditLabel, pendingEdits, subscribePendingEdits } from '../lib/pendingEdits';
import { createStateStore } from '../lib/store';
import { FEATURE_ACTION_LABELS, type BodyDef, type BodyId, type BodyMaking, type CadDoc, type CadView, type Feature, type FeatureId, type FeatureStatus, type FeatureType, type Param, type ParamId, type SavedCamera, type SavedSection, type ScaleModelPlace, type ScaleModels, type Vec2 } from '../types/doc';
import type { AssistantDoc, AssistantStep, BodyProps, DocMark, DocService, DocState, EditResult, EditSession, EndBodies, FeatureFiles, ParamRows, ParamsResult, RebuildState, SaveState, TakeOverWhy } from '../types/doc-service';
import type { DocStore } from '../types/docstore';
import type { CadEvents } from '../types/events';
import type { BodyInfo, KernelAdapter } from '../types/kernel';
import type { SketchSolverClient } from '../types/sketch';
import type { UndoSnapshot } from '../types/undo';
import type { Quantity } from '../types/units';
import { Autosave } from './autosave';
import { namesIn, renameInExpr } from './expr';
import { REPAIR_FUZZY_STEPS } from './features/body-op';
import { storedBodyName } from './features/body-ids';
import { dependencies as featureDependencies, featureUses, gcBodies as gcFeatureBodies, isBodyMaking, ownsBody, renameParamInFeature, withNewBodies } from './features/hooks';
import { createBuiltinRegistry } from './features/registry';
import { createParamScope, featureExprs, paramNameProblem, usersOfParam } from './params';
import { planParams, stillUsed } from './params-bulk';
import { PersonEditing } from './person-editing';
import { RebuildEngine, type RebuildInput, type RebuildOutput } from './rebuild';
import { COLOR_RE, DEFAULT_BODY_COLOR, deepFreeze, emptyDoc, emptyView, PLUGIN_VERSION, readCamera, readScaleModelPlace, readSection, readView } from './schema';
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
  /** The open Assistant step (doc.assistant.begin, until its end()), or null. */
  let step: StepImpl | null = null;
  /** Inside AssistantStep.run: the owner of the step whose synchronous code runs; null otherwise. */
  let currentOwner: string | null = null;
  /** Inside a session's own apply, commit or discard: that session's owner (null: the person's); undefined otherwise. */
  let sessionActor: string | null | undefined = undefined;
  /** The document and view the shown rebuild result was built from (settled compares them with now). */
  let built: RebuildInput | null = null;
  /**
   * A kernel respawn is under way: every shape id of the shown result died, and the
   * rebuild the engine queues once the new worker is ready has not been asked for yet.
   */
  let respawning = kernel.status.get().state === 'restarting';

  // Feature builds read stored files (an import's healed BREP) through ws.files, checked against their sha256.
  const files: FeatureFiles | null = bridge.files
    ? {
        // Magnusim CAD (projectLinks false) has no projects: a Part's files are its own.
        where: bridge.projectLinks() ? 'in the project' : 'with the Part',
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
    onResult(out: RebuildOutput, input: RebuildInput) {
      built = input;
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
      // The new worker is ready and the engine queues the rebuild right after this.
      respawning = false;
      bus.emit('kernel:respawned', { reason, count: kernel.status.get().respawns });
    },
    onIdle() {
      checkSettled();
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

  // ------------------------------------------------------------------ settled

  interface SettledWaiter {
    resolve(r: RebuildState): void;
    reject(e: unknown): void;
    /** Stop listening to its abort signal. */
    off(): void;
  }
  const waiters = new Set<SettledWaiter>();

  /**
   * The shown rebuild is the one of the current document and view: no other result
   * on its way (an old result published just before the next request, or a bodiesAt
   * build holding the engine with no onStart), and its shapes alive.
   */
  function caughtUp(): boolean {
    const s = state.get();
    if (s.status !== 'ready' || !built || respawning || engine.busy()) return false;
    return built.doc === s.doc && (built.view.rollback ?? null) === (rebuildView(s).rollback ?? null);
  }

  function checkSettled() {
    if (!waiters.size) return;
    const s = state.get();
    // A load that failed (one started before the wait began): nothing will be built.
    if (s.status === 'error') return rejectSettled(s.error ?? 'the part could not be read');
    if (!caughtUp()) return;
    const r = s.rebuild;
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.off();
      w.resolve(r);
    }
  }

  function rejectSettled(why: string) {
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.off();
      w.reject(new Error(why));
    }
  }

  function abortReason(signal: AbortSignal): unknown {
    return signal.reason !== undefined ? signal.reason : new Error('aborted');
  }

  function settled(signal?: AbortSignal): Promise<RebuildState> {
    if (disposed) return Promise.reject(new Error('the part was closed'));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const s = state.get();
    if (s.status === 'error') return Promise.reject(new Error(s.error ?? 'the part could not be read'));
    return new Promise<RebuildState>((resolve, reject) => {
      const onAbort = () => {
        if (!waiters.delete(w)) return;
        w.off();
        reject(abortReason(signal!));
      };
      const w: SettledWaiter = { resolve, reject, off: () => signal?.removeEventListener('abort', onAbort) };
      signal?.addEventListener('abort', onAbort);
      waiters.add(w);
      checkSettled();
    });
  }

  // Every change of the model, view, session or rebuild result; the engine's onIdle covers the rest.
  const offSettled = state.subscribe(() => checkSettled());
  const offRespawning = kernel.status.subscribe((k, prev) => {
    if (k.state === prev.state) return;
    if (k.state === 'restarting') {
      respawning = true;
    } else if (respawning) {
      // Ready again (its respawn listeners, the engine's among them, run right after this
      // status: a rebuild is then asked for), or failed or closed: look again once they ran.
      respawning = false;
      queueMicrotask(checkSettled);
    }
  });

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
    // An Assistant step's own change: its undo step carries the step's owner, and the step
    // records the change before anyone hears of it (the save hold reads that record).
    const by = changeBy();
    const mine = ownStep();
    const was = snap();
    if (label && doc !== prev) undo.push(by ? { label, before: prev, after: doc, tag: by } : { label, before: prev, after: doc });
    mine?.advance(was, { doc, rollback: clampView(state.get().view, doc).rollback ?? null, version: undo.version });
    state.set((s) => ({ ...s, doc, view: clampView(s.view, doc), history: historyState() }));
    autosave?.modelChanged();
    rebuild();
  }

  function setView(next: CadView, opts2: { rebuild?: boolean } = {}) {
    const s = state.get();
    if (next === s.view) return;
    // (Under a person's open panel only views change, never the bar: setRollback settles first.)
    if (!personSession()) ownStep()?.advance(snap(), { doc: s.doc, rollback: next.rollback ?? null, version: undo.version });
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

  /**
   * Close an open session (Done) before any other edit, so undo steps stay in order. The person
   * always comes first: inside an Assistant step's run, a session the step does not own (the
   * person's) is never committed (PersonEditing is thrown, and it stays open as it is); outside
   * one, the person's edit takes over a session the Assistant is filling (it is discarded, never
   * committed half-filled).
   */
  function settle() {
    if (!open) return;
    if (currentOwner !== null) {
      if (open.owner !== currentOwner) throw personEditing(open);
      open.commit();
      return;
    }
    if (open.owner) takeOver('edit');
    else open.commit();
  }

  function personEditing(s: SessionImpl): PersonEditing {
    const name = featureById(s.feature)?.name ?? s.draft.name ?? 'a feature';
    return new PersonEditing(`The person is editing ${name}`, s.feature);
  }

  // ------------------------------------------------------------------ Assistant steps

  /** Who makes the change being applied: an Assistant step's owner, or null for the person. */
  function changeBy(): string | null {
    return sessionActor !== undefined ? sessionActor : currentOwner;
  }

  /** The open step, when the change being applied is its own. */
  function ownStep(): StepImpl | null {
    const by = changeBy();
    return step && by !== null && by === step.owner ? step : null;
  }

  interface Snap {
    doc: CadDoc;
    rollback: number | null;
    version: number;
  }

  /** The person's open panel session, or null. */
  function personSession(): SessionImpl | null {
    return open && open.open && !open.owner ? open : null;
  }

  /**
   * The model, the bar and the undo version as they count for an Assistant step: under a person's
   * open panel, what it began on (its live draft is not a change of the Part until its Done).
   */
  function snap(): Snap {
    const s = state.get();
    const p = personSession();
    if (p) return { doc: p.before, rollback: p.barBefore, version: undo.version };
    return { doc: s.doc, rollback: s.view.rollback ?? null, version: undo.version };
  }

  /** Run fn as the Assistant step `owner` (sessions it opens and changes it makes are that step's). */
  function asOwner<T>(owner: string, fn: () => T): T {
    const was = currentOwner;
    currentOwner = owner;
    try {
      return fn();
    } finally {
      currentOwner = was;
    }
  }

  function markNow(): DocMark {
    const s = state.get();
    return Object.freeze({ doc: s.doc, rollback: s.view.rollback ?? null, history: undo.snapshot(), loadSeq });
  }

  /**
   * The person took over the Assistant's open session: it is discarded (never committed), the
   * open step is marked, and the bus hears why. False when no Assistant session is open, unless
   * `owner` names the open step (its panel with no session, the Parameters panel): it is marked.
   */
  function takeOver(why: TakeOverWhy, opts: { owner?: string } = {}): boolean {
    const s = open;
    if (!s || !s.open || !s.owner) {
      if (!opts.owner || !step || step.owner !== opts.owner || step.ended) return false;
      if (!step.takenOver) step.takenOver = why;
      bus.emit('assistant:taken-over', { why });
      return true;
    }
    s.discard();
    if (step && step.owner === s.owner && !step.takenOver) step.takenOver = why;
    bus.emit('assistant:taken-over', { why });
    return true;
  }

  /**
   * Put a mark back: model, bar and both undo lists, one rebuild, no new undo step. A session the
   * Assistant owns goes with it. The person's open session stays open on the restored model when
   * what its draft reads is there as it was when the panel opened (the feature it edits, the
   * features it uses, the parameters); a draft it had applied goes back in on top, still the
   * person's. Otherwise the restore is refused and nothing changes.
   */
  function restoreTo(mark: DocMark): EditResult {
    if (state.get().status !== 'ready') return { ok: false, reason: String(editable()) };
    if (mark.loadSeq !== loadSeq) return { ok: false, reason: 'The part was loaded again since then' };
    const s = open && open.open ? open : null;
    const person = s && !s.owner ? s : null;
    if (person) {
      const why = person.keepsOver(mark.doc);
      if (why) return { ok: false, reason: why };
    }
    const mine = ownStep();
    const was = snap();
    const s0 = state.get();
    // The person's live draft, as the model holds it now (it goes back in on top of the mark).
    const live = person && s0.doc !== person.before ? s0.doc : null;
    if (s && s.owner) s.close();
    undo.restore(mark.history);
    const view = clampView((s0.view.rollback ?? null) === mark.rollback ? s0.view : { ...s0.view, rollback: mark.rollback }, mark.doc);
    if (mine) {
      mine.advance(was, { doc: mark.doc, rollback: view.rollback ?? null, version: undo.version });
      mine.rebase(mark.doc);
    }
    state.set((st) => ({ ...st, doc: mark.doc, view, history: historyState(), session: s && s.owner ? null : st.session }));
    person?.rebase(mark.doc, view, live);
    if (view !== s0.view) autosave?.viewChanged();
    autosave?.modelChanged();
    rebuild();
    return { ok: true };
  }

  class StepImpl implements AssistantStep {
    takenOver: TakeOverWhy | null = null;
    ended = false;
    /** Sealed into its group: what it did is kept (a person's undo from here undoes the group). */
    sealed = false;
    /** The model, the bar and the undo version as this step's own changes left them. */
    doc: CadDoc;
    rollback: number | null;
    version: number;
    /**
     * What seal merges onto: the history and the model at the mark, or as the step's own undo,
     * redo, restore or seal last left them (those keep the history they made; seal merges only the
     * steps pushed after them).
     */
    private base: { history: UndoSnapshot<CadDoc>; doc: CadDoc };
    private result: EditResult | null = null;

    constructor(
      readonly owner: string,
      readonly mark: DocMark,
    ) {
      this.doc = mark.doc;
      this.rollback = mark.rollback;
      this.version = mark.history.version;
      this.base = { history: mark.history, doc: mark.doc };
    }

    /** The step's own undo, redo or restore just moved the undo lists to where they are now, on `doc`. */
    rebase(doc: CadDoc) {
      this.base = { history: undo.snapshot(), doc };
    }

    /**
     * A change of this step's own, from `was` to `now`. Each part of the record moves only from
     * where the step left it: a change someone else made in between is never taken in.
     */
    advance(was: Snap, now: Snap) {
      if (was.doc === this.doc) this.doc = now.doc;
      if (was.rollback === this.rollback) this.rollback = now.rollback;
      if (was.version === this.version) this.version = now.version;
    }

    /**
     * Only this step changed the model, the bar and the undo lists since begin (a take-over aside). A
     * person's panel opened on top is no change until its Done (review: its live draft made every
     * between-opens revert fail).
     */
    mine(): boolean {
      const now = snap();
      return loadSeq === this.mark.loadSeq && now.version === this.version && now.doc === this.doc && now.rollback === this.rollback;
    }

    get clean(): boolean {
      return !this.takenOver && this.mine();
    }

    /** This step changed the model, the bar or the undo lists since begin (or since it went back to its mark), or has a panel session of its own open. */
    changed(): boolean {
      if (this.doc !== this.mark.doc || this.rollback !== this.mark.rollback || (open && open.owner === this.owner)) return true;
      return this.version !== this.mark.history.version && this.version !== this.backAt;
    }

    /** The undo version this step's own restore of its mark left (the lists are the mark's then), or null. */
    private backAt: number | null = null;

    /** Back to the mark, as this step's own change (its revert, a take-over of the whole step). */
    takeBack(): EditResult {
      const r = asOwner(this.owner, () => restoreTo(this.mark));
      if (r.ok) this.backAt = this.version;
      return r;
    }

    /** The save hold: while the step is open and only it changed the model, the stored model stays the mark. */
    holds(): boolean {
      return !this.ended && this.mine();
    }

    run<T>(fn: () => T): T {
      if (this.ended) throw new Error('This Assistant step has ended');
      return asOwner(this.owner, fn);
    }

    seal(tag: string, label: string): void {
      if (this.ended) throw new Error('This Assistant step has ended');
      if (this.takenOver) throw new Error('The person took this step over');
      if (!this.mine()) throw new Error('The Part was changed during this step by someone else');
      if (open && open.owner === this.owner) throw new Error('The Assistant has a panel open in this step');
      this.sealed = true;
      const base = this.base;
      // Only this step changed the history since its base, so every change since is a push of its own.
      if (undo.version === base.history.version) return;
      // The model as its own changes left it (a person's panel open on top is not part of it).
      const doc = this.doc;
      // The history as it was at the base, then this step's pushes as one entry (joined to the group
      // below when that is the same group and ends where they began).
      undo.restore(base.history);
      if (doc !== base.doc) {
        let before = base.doc;
        const below = undo.top;
        if (below && below.tag === tag && below.after === base.doc) {
          before = below.before;
          undo.dropTop();
        }
        undo.push({ label, before, after: doc, tag });
      }
      this.version = undo.version;
      this.rebase(doc);
      state.set((s) => ({ ...s, history: historyState() }));
    }

    revert(): EditResult {
      if (this.result) return this.result;
      if (this.ended) return (this.result = { ok: false, reason: 'This Assistant step has ended' });
      if (!this.mine()) {
        const reason = loadSeq !== this.mark.loadSeq ? 'The part was loaded again during this step' : 'The Part was changed during this step by someone else, so it was kept as it is';
        return (this.result = { ok: false, reason });
      }
      this.result = this.changed() ? this.takeBack() : { ok: true };
      return this.result;
    }

    left(): string[] {
      return undo.snapshot().done.filter((e) => e.tag === this.owner).map((e) => e.label);
    }

    end(): void {
      if (this.ended) return;
      // A session of this step's still open (its call did not drop it): it goes, never left behind.
      if (open && open.owner === this.owner) open.discard();
      this.ended = true;
      if (step === this) step = null;
      // The hold is released: one write when the model differs from what is stored.
      autosave?.modelChanged();
      bus.emit('assistant:step-ended', { owner: this.owner });
    }
  }

  const assistant: AssistantDoc = {
    begin(owner: string): AssistantStep {
      if (!owner) throw new Error('An Assistant step needs its owner');
      if (step) throw new Error('An Assistant step is already open');
      const ok = editable();
      if (ok !== true) throw new Error(ok);
      if (open && open.open) throw personEditing(open);
      step = new StepImpl(owner, markNow());
      return step;
    },
    current: () => step,
    mark: markNow,
    restore(mark) {
      const no = refuse();
      return no ?? restoreTo(mark);
    },
    topGroup() {
      const t = undo.top;
      return t && t.tag ? { tag: t.tag, label: t.label, after: t.after } : null;
    },
    undoGroup(tag) {
      const no = refuse();
      if (no) return no;
      if (undo.top?.tag !== tag) return { ok: false, reason: 'Those changes are no longer the newest step' };
      if (open && open.open) return { ok: false, reason: 'Close the open panel first' };
      doUndo(false);
      return { ok: true };
    },
    takeOver,
    undoTakesOver: () => !!undoTakesStep(),
  };

  // ------------------------------------------------------------------ sessions

  class SessionImpl implements EditSession {
    readonly id = newId('s');
    readonly feature: FeatureId;
    /** The Assistant step that opened it (inside its run), absent for the person's. */
    readonly owner?: string;
    open = true;
    private current: Feature;
    /** The document when the session opened (a refused Delete checks it too); moved by an Assistant restore. */
    before: CadDoc;
    private viewBefore: CadView;
    private inDoc: boolean;
    private lastCreates: BodyId | null;

    constructor(
      draft: Feature,
      readonly isNew: boolean,
      private insertAt: number,
    ) {
      this.feature = draft.id;
      if (currentOwner !== null) this.owner = currentOwner;
      this.current = draft;
      this.before = state.get().doc;
      this.viewBefore = state.get().view;
      this.inDoc = !isNew;
      this.lastCreates = isBodyMaking(draft) ? draft.creates : null;
      // The open session from the start: its first apply already rebuilds as this session (isolateWhileEditing).
      open = this;
      try {
        if (isNew) this.act(() => this.apply());
        else if (this.def()?.isolateWhileEditing) rebuild();
      } catch (e) {
        // A draft its type cannot read (a pattern without dir1 throws in incomplete()):
        // no dead session is left open, the part is as it was, and the caller hears why.
        this.discard();
        throw e;
      }
    }

    /** The session's own changes are its owner's (an Assistant step's, or the person's), whoever calls. */
    private act<T>(fn: () => T): T {
      const was = sessionActor;
      sessionActor = this.owner ?? null;
      try {
        return fn();
      } finally {
        sessionActor = was;
      }
    }

    /** The rollback bar when the session opened (moved by an Assistant restore). */
    get barBefore(): number | null {
      return this.viewBefore.rollback ?? null;
    }

    /**
     * Why this (the person's) session cannot stay open over an Assistant restore to `target`, or
     * null: what its draft reads must be in `target` as it was when the panel opened (the feature it
     * edits, the features it uses: its parents and the makers of the bodies it names; the parameters,
     * when it names any).
     */
    keepsOver(target: CadDoc): string | null {
      const from = this.before;
      const at = (doc: CadDoc, id: FeatureId) => doc.features.find((f) => f.id === id);
      const nameOf = (id: FeatureId) => at(from, id)?.name ?? 'a feature';
      if (!this.isNew && at(target, this.feature) !== at(from, this.feature)) return `The person is editing ${nameOf(this.feature)}, which this would change`;
      const what = this.current.name || 'feature';
      let used: FeatureId | undefined;
      let named: boolean;
      try {
        used = dependencies(from, this.current).find((id) => at(target, id) !== at(from, id));
        named = featureExprs(this.current, registry).some((e) => namesIn(e.expr).length > 0);
      } catch {
        // A draft its type cannot read yet: what it uses is unknown, so it is not moved.
        return `The person is editing ${what}`;
      }
      if (used) return `The person's ${what} uses ${nameOf(used)}, which this would change`;
      if (named && target.params !== from.params) return `The person's ${what} uses parameters, which this would change`;
      return null;
    }

    /**
     * An Assistant restore put `doc` and `view` under this (the person's) session: it now began
     * there. A draft it had applied (as `live` held it) goes back in on top, at the bar for a new
     * feature, in place for an edit, with the bodies it makes: still the person's change.
     */
    rebase(doc: CadDoc, view: CadView, live: CadDoc | null) {
      this.before = doc;
      this.viewBefore = view;
      if (this.isNew) {
        this.inDoc = false;
        this.insertAt = view.rollback ?? doc.features.length;
      }
      const f = live?.features.find((g) => g.id === this.feature);
      if (!live || !f) return;
      this.act(() => {
        let next = state.get().doc;
        const made = Object.keys(live.bodies).filter((b) => !next.bodies[b] && ownsBody(registry, f, b));
        if (made.length) next = { ...next, bodies: { ...next.bodies, ...Object.fromEntries(made.map((b) => [b, live.bodies[b]])) } };
        if (this.inDoc) next = replaceFeature(next, f);
        else {
          const features = [...next.features];
          features.splice(this.insertAt, 0, f);
          next = { ...next, features };
          this.inDoc = true;
          const v = state.get().view;
          // Inserted at the rollback bar: the bar moves below it, as when it first applied.
          if (v.rollback != null && v.rollback >= this.insertAt) setView({ ...v, rollback: v.rollback + 1 });
        }
        applyDoc(next, null);
      });
    }

    /** Ended with no change of its own (an Assistant restore replaces the model it was on). */
    close() {
      this.open = false;
      if (open === this) open = null;
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
      this.act(() => this.apply());
    }

    commit(): void {
      this.act(() => this.commitNow());
    }

    discard(): void {
      this.act(() => this.discardNow());
    }

    private commitNow(): void {
      if (!this.open) return;
      if (this.isNew && (!this.inDoc || this.incomplete() !== null)) {
        this.discardNow();
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

    private discardNow(): void {
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
    // The open session on it, when it is the caller's own (the person's, or the running step's).
    if (open && open.feature === id && (open.owner ?? null) === currentOwner) return open;
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
    if (open && open.feature === id) {
      // Inside an Assistant step, never the person's session; the person deleting what the
      // Assistant is filling takes it over.
      if (currentOwner !== null && open.owner !== currentOwner) throw personEditing(open);
      if (currentOwner === null && open.owner) takeOver('edit');
      else open.discard();
    }
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
      // A body that is gone leaves the hidden and the see-through lists.
      const see = v.seeThroughBodies ?? [];
      if ((v.rollback != null && idx < v.rollback) || gone.some((b) => v.hiddenBodies.includes(b) || see.includes(b))) {
        const view: CadView = { ...v, rollback: v.rollback != null && idx < v.rollback ? v.rollback - 1 : v.rollback, hiddenBodies: v.hiddenBodies.filter((b) => !gone.includes(b)) };
        const kept = see.filter((b) => !gone.includes(b));
        if (kept.length) view.seeThroughBodies = kept;
        else delete view.seeThroughBodies;
        setView(view);
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
   * The person's newest `count` undo steps as one, labelled `label` (a Hole's sketch and cut, the
   * features one Delete removed): one Ctrl+Z takes them all back, as the Assistant's own request
   * steps are one. Refused, with nothing changed, while an Assistant step or a panel session is
   * open, or when those steps are not all the person's and one after the other.
   */
  function joinSteps(count: number, label: string): EditResult {
    const n = Math.floor(count);
    if (n < 2) return { ok: true };
    if (step && !step.ended) return { ok: false, reason: 'The Assistant is changing the part' };
    if (open && open.open) return { ok: false, reason: 'A panel is open' };
    const done = undo.snapshot().done;
    if (done.length < n) return { ok: false, reason: `There are only ${done.length} steps to join` };
    const last = done.slice(-n);
    if (last.some((e) => e.tag)) return { ok: false, reason: "Those steps are not all the person's" };
    for (let i = 1; i < last.length; i++) if (last[i].before !== last[i - 1].after) return { ok: false, reason: 'Those steps do not follow each other' };
    for (let i = 0; i < n; i++) undo.dropTop();
    undo.push({ label, before: last[0].before, after: last[n - 1].after });
    state.set((s) => ({ ...s, history: historyState() }));
    return { ok: true };
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
      if (names.length) return { ok: false, reason: stillUsed(p.name, names) };
      return { doc: { ...doc, params: doc.params.filter((x) => x.id !== id) }, label: `Delete parameter ${p.name}` };
    });
  }

  /**
   * Bulk parameters (planParams): one settle, one check of the final set, one undo step. Inside an
   * Assistant step's run, a person's open panel throws PersonEditing as every edit does.
   */
  function editParams(rows: ParamRows, label?: string): ParamsResult {
    const no = refuse();
    if (no) return no;
    settle();
    const doc = state.get().doc;
    const plan = planParams(doc, rows, registry);
    if (!plan.ok) return plan;
    if (plan.doc !== doc) applyDoc(plan.doc, label ?? `Parameters: ${plan.count} changed`);
    return { ok: true, ids: plan.ids };
  }

  /**
   * The open Assistant step a person's Ctrl+Z or Ctrl+Y would take over whole, or null: it changed
   * the Part (one piece or several: a hole's sketch and cut, an extrude and its body's name), only
   * it did, and no panel session is open (between its panels, while it waits for its rebuild,
   * judges, paces or waits for Keep).
   */
  function undoTakesStep(): StepImpl | null {
    return step && !step.ended && !step.sealed && !(open && open.open) && step.mine() && step.changed() ? step : null;
  }

  function doUndo(redo: boolean) {
    if (editable() !== true) return;
    const person = currentOwner === null;
    // The person's Ctrl+Z or Ctrl+Y while the Assistant fills a panel: that panel goes (a
    // take-over), and nothing else is undone.
    if (person && open?.owner) {
      takeOver('undo');
      return;
    }
    // The person's Ctrl+Z or Ctrl+Y while an Assistant step that changed the Part is open with no
    // panel: a take-over of the whole step. Every piece of it goes back to its mark at once (the
    // model, the bar and both undo lists as before the step), and nothing else is undone (review:
    // only its newest piece went; the rest stayed unsealed, outside the request's group, and was saved).
    const whole = person ? undoTakesStep() : null;
    if (whole) {
      if (!whole.takenOver) whole.takenOver = 'undo';
      bus.emit('assistant:taken-over', { why: 'undo' });
      // Not the step's revert (whose answer is kept): the call's own revert later takes back anything it still did.
      whole.takeBack();
      return;
    }
    settle();
    const entry = redo ? (undo.snapshot().undone.slice(-1)[0] ?? null) : undo.top;
    if (!entry) return;
    if (person) {
      // Heard before it applies. During an Assistant step it is a take-over: the step is never
      // sealed over it, and the person's undo always goes ahead.
      bus.emit('assistant:person-undo', { tag: entry.tag ?? null, label: entry.label, redo });
      if (step && !step.takenOver) step.takenOver = 'undo';
    }
    const mine = ownStep();
    const was = snap();
    const before = state.get().doc;
    const target = redo ? undo.redo() : undo.undo();
    if (!target) return;
    const doc = target;
    const view = keepBar(state.get().view, before, doc);
    const moved = view !== state.get().view;
    if (mine) {
      mine.advance(was, { doc, rollback: view.rollback ?? null, version: undo.version });
      mine.rebase(doc);
    }
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

  function setBodiesSeeThrough(ids: readonly BodyId[], on: boolean) {
    const v = state.get().view;
    const was = v.seeThroughBodies ?? [];
    const now = on ? [...was, ...ids.filter((id, i) => !was.includes(id) && ids.indexOf(id) === i)] : was.filter((b) => !ids.includes(b));
    if (now.length === was.length) return;
    const view: CadView = { ...v };
    if (now.length) view.seeThroughBodies = now;
    else delete view.seeThroughBodies;
    setView(view);
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

  function setSection(section: SavedSection | null) {
    const v = state.get().view;
    if (state.get().status !== 'ready') return;
    const next = section ? readSection(section) : null;
    if (JSON.stringify(v.section ?? null) === JSON.stringify(next)) return;
    const view: CadView = { ...v };
    if (next) view.section = next;
    else delete view.section;
    setView(view);
  }

  function setCamera(camera: SavedCamera) {
    const v = state.get().view;
    const c = readCamera(camera);
    if (state.get().status !== 'ready' || !c || JSON.stringify(v.camera ?? null) === JSON.stringify(c)) return;
    setView({ ...v, camera: c });
  }

  // ux010 (TOOLBAR builder): the banana for scale, kept with the view.
  function setScaleModel(kind: 'banana', place: ScaleModelPlace | null) {
    const v = state.get().view;
    if (state.get().status !== 'ready') return;
    const cur = v.scaleModels?.[kind] ?? null;
    const next = place ? readScaleModelPlace(place) : null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    const models = { ...(v.scaleModels ?? {}) };
    if (next) models[kind] = next;
    else delete models[kind];
    const view: CadView = { ...v, scaleModels: models };
    if (!Object.keys(models).length) delete view.scaleModels;
    setView(view);
  }

  // ux010 (TOOLBAR builder): the taped banana per sketch, kept with the view. Entries of sketches
  // no longer in the Part are dropped on the way.
  function setSketchBanana(feature: FeatureId, at: Vec2 | null) {
    const v = state.get().view;
    if (state.get().status !== 'ready') return;
    const cur = v.scaleModels?.sketch?.[feature]?.at ?? null;
    const next = at && at.length === 2 && at.every((n) => Number.isFinite(n)) ? ([at[0], at[1]] as Vec2) : null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    const known = new Set(state.get().doc.features.map((f) => f.id));
    const sketch: Record<FeatureId, { at: Vec2 }> = {};
    for (const [id, e] of Object.entries(v.scaleModels?.sketch ?? {})) if (id !== feature && known.has(id)) sketch[id] = e;
    if (next) sketch[feature] = { at: next };
    const models: ScaleModels = { ...(v.scaleModels ?? {}), sketch };
    if (!Object.keys(sketch).length) delete models.sketch;
    const view: CadView = { ...v, scaleModels: models };
    if (!Object.keys(models).length) delete view.scaleModels;
    setView(view);
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
      if (b.volume === p.volume && b.area === p.area && b.solids === p.solids && b.shells === p.shells) return s;
      const next: BodyInfo = { ...b, volume: p.volume, area: p.area, bbox: p.bbox, faces: p.faces, edges: p.edges, solids: p.solids, shells: p.shells };
      const bodies = [...s.rebuild.bodies];
      bodies[i] = next;
      return { ...s, rebuild: { ...s.rebuild, bodies } };
    });
    return p;
  }

  // ------------------------------------------------------------------ load / save

  async function load(): Promise<void> {
    const my = ++loadSeq;
    // A wait for the old model's rebuild ends here: that model is being replaced.
    rejectSettled('the part was loaded again');
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
          // The save hold: while an Assistant step is open and only it changed the model, every
          // write path (the budget, blur, hidden, pagehide, flush) stores the step's mark, and a
          // write equal to what is stored is skipped. A reload, crash or Back mid-call never stores
          // half a step; the hold lifts the moment anyone else changes the model, and end() writes.
          getDoc: () => (step && step.holds() ? step.mark.doc : state.get().doc),
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
    joinSteps,
    renameBody,
    setBodyColor,
    setBodyInSimulation,
    addParam,
    updateParam,
    removeParam,
    editParams,
    undo: () => doUndo(false),
    redo: () => doUndo(true),
    repair,
    retry,
    setRollback,
    setBodyVisible,
    setBodiesSeeThrough,
    setExpanded,
    setPlanes,
    setSection,
    setCamera,
    setSketchVisibility,
    setScaleModel,
    setSketchBanana,
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
    async bodiesBefore(feature): Promise<EndBodies> {
      const s = state.get();
      if (s.status !== 'ready') throw new Error(s.status === 'loading' ? 'the part is still loading' : (s.error ?? 'the part could not be read'));
      const at = s.doc.features.findIndex((f) => f.id === feature);
      if (at < 0) throw new Error('That feature is not in the part');
      return engine.bodiesAt(s.doc, s.view, at);
    },
    settled,
    committed: () => (open && open.open ? open.before : state.get().doc),
    recordSettled: () => record.settled(),
    assistant,
    dispose() {
      if (disposed) return;
      disposed = true;
      rejectSettled('the part was closed');
      offSettled();
      offRespawning();
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

