// Sketch mode (proposal §3.3, docs/p2p3-plan.md §3.4): entered when a panel
// session opens on a sketch, left when it closes. While it is on it owns
// services.mode ('sketch'), the camera's first move (normal to the sketch),
// the viewport's left button (its pointer tool), its overlay layers, the
// sketch selection items, and the sketch's local undo. Every edit is solved in
// the solver worker first and then stored with session.update (one sketch
// undo step; the whole session is one document undo step). Drags run in the
// solver (coalesced moves) and are stored once, at the end.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../lib/store';
import { clearSelection } from '../lib/selection';
import type { AppServices } from '../types/app';
import type { DocState, EditSession } from '../types/doc-service';
import { ORIGIN_PLANES, type FeatureId, type PlaneFrame, type SketchConstraint, type SketchFeature, type SketchSupport, type Vec2, type Vec3 } from '../types/doc';
import type { SelectionItem } from '../types/selection';
import type { SketchModeApi, SketchModeState, SketchOutput, SketchToolId, SolverAnalysis, SolverSolveResult } from '../types/sketch';
import type { StateStore } from '../types/state';
import type { ViewportHandle } from '../types/viewport';
import { uiFor } from '../ui/controller';
import { kernelLookup, refOfFace, resolveFace } from '../naming';
import { solvedStateOf, statusOf, type SketchStatus } from './dof';
import { SketchBuilder, type EditOutcome, type SketchDraft } from './edit';
import { constraintLabel, DIMENSION_LABELS, entityLabel, entityOf, evaluateDimensions, isDimension, measureDimension, quantityOf, toSolverSketch, withSolved } from './model';
import type { SolverClient } from './solver-client';
import { prunedLinks } from './project/curves';
import { sketchUp } from '../viewport/normal';
// P4b (SKETCH): sketch patterns and offsets.
import { prunedTies, tiesDissolved } from './tools/ties';

/** A sketch item under the pointer or in the selection. */
export interface SketchHit {
  what: 'point' | 'entity' | 'constraint';
  id: string;
}

/** Transient drawing a tool shows (rubber band, inference, window). */
export interface SketchPreview {
  /** Curves in progress, drawn in the preview colour. */
  lines: [Vec2, Vec2][];
  arcs: { c: Vec2; r: number; a0: number; sweep: number }[];
  points: Vec2[];
  /** Dashed guides (inference, alignment). */
  guides: [Vec2, Vec2][];
  /** Inference glyphs at a place. */
  glyphs: { at: Vec2; kinds: string[] }[];
  /** Pieces about to go (trim): drawn in red. */
  doomed: [Vec2, Vec2][];
  /** Window selection rectangle (two corners; crossing = dashed). */
  window: { a: Vec2; b: Vec2; crossing: boolean } | null;
  /** Value boxes typed while drawing. */
  boxes: ValueBox[];
  /** A dimension being placed (its label follows the pointer). */
  dimension: { kind: SketchConstraint['kind']; refs: string[]; at: Vec2 } | null;
}

export interface ValueBox {
  id: string;
  label: string;
  /** Where it sits (sketch u/v) and its pixel offset. */
  at: Vec2;
  /** The segment it measures (a line's length, a rectangle's side): the box sits beside it, across from its middle. */
  along?: [Vec2, Vec2] | null;
  /** The text in the box (typed, or the value now). */
  text: string;
  locked: boolean;
  error: string | null;
  quantity: 'length' | 'angle';
}

export interface SketchView {
  /** What is drawn: the session's draft, or the geometry of a drag in progress. */
  draft: SketchFeature | null;
  plane: PlaneFrame | null;
  analysis: SolverAnalysis | null;
  status: SketchStatus | null;
  hover: SketchHit | null;
  preview: SketchPreview | null;
  /** The last refused action, in words (the panel's foot). */
  note: string | null;
  /** "Make it driven?" */
  prompt: { title: string; copy: string; accept: string; resolve(yes: boolean): void } | null;
  /** A dimension whose value box is open. */
  editing: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** The line tool's next segment is a tangent arc (A toggles it while a chain is open). */
  lineArc: boolean;
  dragging: boolean;
  /** The canvas cursor the tool wants now. */
  cursor: string;
  /** The tool's one-line instruction for the panel. */
  hint: string;
}

/** A tool's pointer event on the sketch plane. */
export interface SketchPointer {
  type: 'down' | 'move' | 'up' | 'click' | 'dblclick' | 'leave';
  uv: Vec2;
  /** mm per CSS pixel at the sketch. */
  px: number;
  ctrl: boolean;
  shift: boolean;
  /** A button is held (move events during a press). */
  pressed: boolean;
  clientX: number;
  clientY: number;
}

export interface SketchTool {
  readonly id: SketchToolId;
  pointer(e: SketchPointer): void;
  /** Drop what is in progress; true when there was something. */
  cancel(): boolean;
  /** The panel's hint for this tool now. */
  hint(): string;
  /**
   * A value box changed (typed while drawing). For 'enter': true when the shape
   * was placed (the overlay then lets go of the box, so the next digit starts
   * the next shape's first box and letters reach the shortcuts again).
   */
  box?(id: string, action: 'input' | 'tab' | 'enter', text: string): boolean | void;
  /** The line tool: the next segment of an open chain becomes a tangent arc (or a line again). False when no chain is open. */
  toggleArc?(): boolean;
  dispose?(): void;
  // ---- P4b (SKETCH)
  /** Enter while the tool has an open step (sketch.enter, src/sketch/tools/commands.ts): it places what is drawn and returns true; false lets Enter finish the sketch. */
  commit?(): boolean;
  /** The tool's options, drawn in the sketch panel (src/sketch/tools/options.tsx). */
  options?(): import('./tools/options').ToolOption[];
  // ---- P4b (INTEGRATE, mouse binding 2026-10-06)
  /**
   * Whether a left press (no Alt) is the tool's. Absent: every left press is (the drawing tools).
   * The Select tool takes a press on sketch geometry (to drag it) and a Ctrl press (the box); a
   * plain or Shift press elsewhere goes to the viewport, which orbits or pans as the core viewer
   * does; its click still reaches the tool.
   */
  takesPress?(e: SketchPointer): boolean;
}

export type ToolFactory = (mode: SketchMode, id: SketchToolId) => SketchTool;

export interface ApplyOptions {
  /** What a new over-definition does: refuse the edit (default), or ask the caller (a dimension: "Make it driven?"). */
  over?: 'refuse' | 'report';
  /** Constraint ids sketch mode may drop when they over-define (inference, helpers). */
  optional?: readonly string[];
  /** Keep the result even when the solver cannot satisfy it (never used for user edits). */
  noUndo?: boolean;
}

export type ApplyResult = { ok: true; draft: SketchFeature } | { ok: false; reason: string; over?: boolean };

const EMPTY_PREVIEW: SketchPreview = { lines: [], arcs: [], points: [], guides: [], glyphs: [], doomed: [], window: null, boxes: [], dimension: null };
export function emptyPreview(): SketchPreview {
  return { ...EMPTY_PREVIEW, lines: [], arcs: [], points: [], guides: [], glyphs: [], doomed: [], boxes: [] };
}

function snapshot(d: SketchFeature): SketchDraft & Pick<SketchFeature, 'solved' | 'links' | 'ties'> {
  // P4b (SELECT): linked geometry's sources go with their entities. P4b (SKETCH): so do pattern / offset ties.
  return { points: d.points, entities: d.entities, constraints: d.constraints, solved: d.solved, links: d.links, ties: d.ties };
}

/** ydir = normal x xdir. */
export function planeY(p: PlaneFrame): Vec3 {
  const [nx, ny, nz] = p.normal;
  const [x, y, z] = p.xdir;
  return [ny * z - nz * y, nz * x - nx * z, nx * y - ny * x];
}

/** A sketch u/v point in model coordinates. */
export function toModel(p: PlaneFrame, uv: Vec2): Vec3 {
  const y = planeY(p);
  return [p.origin[0] + uv[0] * p.xdir[0] + uv[1] * y[0], p.origin[1] + uv[0] * p.xdir[1] + uv[1] * y[1], p.origin[2] + uv[0] * p.xdir[2] + uv[1] * y[2]];
}

const controllers = new WeakMap<AppServices, SketchMode>();
export function modeFor(services: AppServices): SketchMode | null {
  return controllers.get(services) ?? null;
}

export class SketchMode implements SketchModeApi {
  readonly state: StateStore<SketchModeState>;
  readonly view: StateStore<SketchView>;
  session: EditSession | null = null;
  tool: SketchTool | null = null;
  private undoStack: ReturnType<typeof snapshot>[] = [];
  private redoStack: ReturnType<typeof snapshot>[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private lastSolve: SolverSolveResult | null = null;
  private offs: (() => void)[] = [];
  private attached: (() => void) | null = null;
  private drag: { base: SketchFeature; moved: boolean } | null = null;
  /** Called with the viewport handle on enter (the overlay and the pointer router). */
  onAttach: ((handle: ViewportHandle) => () => void) | null = null;
  /** P4b (SELECT): the overlay sends the last pointer move to the tool again (a snap on the model became ready). */
  repeatPointer: (() => void) | null = null;

  constructor(
    readonly services: AppServices,
    readonly solver: SolverClient,
    private readonly makeTool: ToolFactory,
  ) {
    controllers.set(services, this);
    this.state = createStateStore<SketchModeState>({ feature: null, tool: 'select', status: null, analyzing: false, typing: false });
    this.view = createStateStore<SketchView>({
      draft: null,
      plane: null,
      analysis: null,
      status: null,
      hover: null,
      preview: null,
      note: null,
      prompt: null,
      editing: null,
      canUndo: false,
      canRedo: false,
      lineArc: false,
      dragging: false,
      cursor: '',
      hint: '',
    });
    const { doc } = services;
    this.offs.push(
      doc.state.subscribe((s, prev) => {
        if (s.session !== prev.session) this.syncSession();
        // The session's draft changed outside sketch mode's own edits (a rename in the panel head).
        if (this.session && !this.drag && s.doc !== prev.doc) {
          const d = this.session.draft;
          if (d.type === 'sketch' && d !== this.view.get().draft) this.view.set({ draft: d });
        }
        // The plane as the rebuild resolved it (a face support may have moved).
        if (this.session && s.rebuild.outputs !== prev.rebuild.outputs) {
          const out = s.rebuild.outputs[this.session.feature] as SketchOutput | undefined;
          if (out?.type === 'sketch' && out.plane && !samePlane(out.plane, this.view.get().plane)) this.view.set({ plane: out.plane });
        }
      }),
    );
    this.offs.push(
      services.viewport.subscribe((v, prev) => {
        if (v.handle !== prev.handle && this.session) this.attach();
      }),
    );
  }

  // ------------------------------------------------------------ the session

  get feature(): FeatureId | null {
    return this.session?.feature ?? null;
  }

  get active(): boolean {
    return !!this.session && this.session.open;
  }

  /** The draft as stored by the session (not a drag in progress). */
  stored(): SketchFeature | null {
    const d = this.session?.draft;
    return d && d.type === 'sketch' ? d : null;
  }

  /** What is drawn now. */
  draft(): SketchFeature | null {
    return this.view.get().draft ?? this.stored();
  }

  plane(): PlaneFrame | null {
    return this.view.get().plane ?? this.stored()?.plane ?? null;
  }

  private syncSession() {
    const { doc } = this.services;
    const s = doc.state.get().session;
    const open = s ? doc.session() : null;
    const isSketch = !!open && open.open && open.draft.type === 'sketch';
    if (isSketch && this.session === open) return;
    if (this.session) this.leave();
    if (isSketch && open) this.enter(open);
  }

  private enter(session: EditSession) {
    this.session = session;
    this.undoStack = [];
    this.redoStack = [];
    this.lastSolve = null;
    const d = session.draft as SketchFeature;
    const out = this.services.doc.state.get().rebuild.outputs[session.feature] as SketchOutput | undefined;
    const plane = out?.type === 'sketch' && out.plane ? out.plane : d.plane;
    this.view.set({ draft: d, plane, analysis: null, status: null, hover: null, preview: null, note: null, prompt: null, editing: null, canUndo: false, canRedo: false, lineArc: false, dragging: false, cursor: '', hint: '' });
    this.services.mode.set({ mode: 'sketch' });
    this.state.set({ feature: session.feature, tool: 'select', status: null, analyzing: false, typing: false });
    this.tool = this.makeTool(this, 'select');
    this.refreshHint();
    // The model selection (the sketch feature the panel selected) gives way to the sketch's own.
    clearSelection(this.services.selection);
    this.attach();
    const h = this.services.viewport.get().handle;
    // P4b SELECT (fix round 1): the up every Normal to uses for a sketch (never upside down).
    if (h && plane) h.lookAt(plane.normal, sketchUp(plane));
    this.reframeWhenRolledBack(session);
    this.services.bus.emit('sketch:mode', { feature: session.feature });
    // Solve what is stored (a parameter may have changed a dimension) and analyse it.
    void this.enqueue(() => this.settleStored());
  }

  /** Stops watching for the rollback of a reopened sketch (reframeWhenRolledBack). */
  private offRollback: (() => void) | null = null;

  /**
   * A sketch reopened with features after it: its rebuild stops after it (isolateWhileEditing), so
   * the bodies made later are rolled back, but the camera moved before that rebuild came. Once it
   * has, the view frames the sketch and the bodies drawn now, unless the user moved the camera
   * meanwhile (review P2/P3 round 4: the view stayed on a later Box the rollback hid, with most
   * of the sketch and its dimensions off-screen).
   */
  private reframeWhenRolledBack(session: EditSession) {
    this.offRollback?.();
    this.offRollback = null;
    const { doc } = this.services;
    const rolledBack = (s: DocState) => {
      if (s.rebuild.status === 'running') return false;
      const at = s.doc.features.findIndex((f) => f.id === session.feature);
      if (at < 0) return true;
      return s.doc.features.slice(at + 1).every((f) => s.rebuild.features[f.id]?.state === 'rolled-back');
    };
    if (rolledBack(doc.state.get())) return;
    const off = doc.state.subscribe((s) => {
      if (this.session !== session) {
        stop();
        return;
      }
      if (!rolledBack(s)) return;
      stop();
      // After every listener of this change: the viewport has the rolled-back bodies by then.
      queueMicrotask(() => {
        if (this.session === session) this.services.viewport.get().handle?.reframe();
      });
    });
    const stop = () => {
      off();
      if (this.offRollback === stop) this.offRollback = null;
    };
    this.offRollback = stop;
  }

  private leave() {
    this.offRollback?.();
    const feature = this.session?.feature ?? null;
    this.tool?.cancel();
    this.tool?.dispose?.();
    this.tool = null;
    this.session = null;
    this.drag = null;
    this.detach();
    this.view.set({ draft: null, plane: null, analysis: null, status: null, hover: null, preview: null, note: null, prompt: null, editing: null, canUndo: false, canRedo: false, dragging: false, cursor: '', hint: '' });
    this.state.set({ feature: null, tool: 'select', status: null, analyzing: false, typing: false });
    this.services.mode.set({ mode: 'model' });
    // Sketch items leave the selection with sketch mode.
    if (feature) this.services.selection.set((sel) => ({ ...sel, items: sel.items.filter((it) => !(it.kind === 'sketch' && it.feature === feature)) }));
    this.services.bus.emit('sketch:mode', { feature: null });
  }

  private attach() {
    this.detach();
    const h = this.services.viewport.get().handle;
    if (!h || !this.onAttach) return;
    this.attached = this.onAttach(h);
  }

  private detach() {
    const off = this.attached;
    this.attached = null;
    off?.();
  }

  // ------------------------------------------------------------ SketchModeApi

  newSketch(support: SketchSupport): void {
    void this.startSketch(support).then((r) => {
      if (r !== true) uiFor(this.services).fail('New sketch', r);
    });
  }

  /**
   * A new sketch on an origin plane, or on a planar face given by its stored
   * reference (resolved on its body now) or by a pick (body + face index: the
   * reference is made here, the one re-anchoring point).
   */
  async startSketch(support: SketchSupport | { kind: 'pick'; body: string; index: number }): Promise<true | string> {
    const ui = uiFor(this.services);
    const block = ui.editBlock();
    if (block) return block;
    if (!this.services.doc.features.get('sketch')) return 'this version of Magnusim CAD cannot make sketches';
    let plane: PlaneFrame;
    let sup: SketchSupport;
    if (support.kind === 'plane') {
      const o = ORIGIN_PLANES[support.plane];
      plane = { origin: [...o.origin] as Vec3, normal: [...o.normal] as Vec3, xdir: [...o.xdir] as Vec3 };
      sup = support;
    } else if (support.kind === 'feature') {
      // P4a (REFERENCE): a CONSTRUCT plane, as built now; the sketch follows it from then on.
      const s = this.services.doc.state.get();
      const out = s.rebuild.outputs[support.feature];
      const name = s.doc.features.find((f) => f.id === support.feature)?.name ?? 'that plane';
      if (!out || out.type !== 'plane') return `${name} is not built, so a sketch cannot go on it`;
      plane = { origin: [...out.frame.origin] as Vec3, normal: [...out.frame.normal] as Vec3, xdir: [...out.frame.xdir] as Vec3 };
      sup = support;
    } else {
      const info = this.services.doc.state.get().rebuild.bodies.find((b) => b.id === support.body);
      if (!info) return 'that body is not built';
      if (!info.names) return 'that face has no name yet, so a sketch on it would not survive a rebuild';
      const lookup = kernelLookup(this.services.kernel);
      try {
        let index: number;
        let ref;
        if (support.kind === 'pick') {
          index = support.index;
          ref = await refOfFace(lookup, info.shape, info.names, index);
        } else {
          const r = await resolveFace({ ref: support.face, shape: info.shape, names: info.names, lookup });
          if (!r.ok) return r.message;
          index = r.index;
          ref = support.face;
        }
        const [topo] = await lookup.faces(info.shape, [index]);
        if (!topo || topo.type !== 'plane' || !topo.normal) return 'sketches go on flat faces: that face is curved';
        plane = faceFrame(topo.normal, topo.centroid ?? [0, 0, 0]);
        sup = { kind: 'face', body: support.body, face: ref };
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    ui.openNew('sketch', { support: sup, plane } as Partial<SketchFeature>);
    return true;
  }

  edit(feature: FeatureId): void {
    uiFor(this.services).openEdit(feature);
  }

  /** Finish sketch (Done, Enter): the edits still being solved are stored first, then the session closes. */
  finish(): Promise<void> {
    const session = this.session;
    if (!session) return Promise.resolve();
    this.tool?.cancel();
    return this.idle().then(() => {
      if (this.session !== session || !session.open) return;
      // The plane the support resolved to is the sketch's snapshot from now on (§4.5 point 5).
      const d = this.stored();
      const p = this.view.get().plane;
      if (d && p && !samePlane(p, d.plane)) session.update({ plane: { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 } } as Partial<SketchFeature>);
      uiFor(this.services).closePanel();
    });
  }

  setTool(tool: SketchToolId): void {
    if (!this.session) return;
    if (this.tool?.id === tool) return;
    this.tool?.cancel();
    this.tool?.dispose?.();
    this.tool = this.makeTool(this, tool);
    this.state.set({ tool, typing: false });
    this.view.set({ preview: null, hover: null, cursor: '' });
    this.refreshHint();
  }

  refreshHint() {
    this.view.set({ hint: this.tool?.hint() ?? '' });
  }

  /** Escape: the tool's step, then the tool, then the selection. Never finishes the sketch. */
  escape(): void {
    const v = this.view.get();
    if (v.prompt) {
      v.prompt.resolve(false);
      return;
    }
    if (v.editing) {
      this.view.set({ editing: null });
      return;
    }
    if (this.tool?.cancel()) {
      this.refreshHint();
      return;
    }
    if (this.tool && this.tool.id !== 'select') {
      this.setTool('select');
      return;
    }
    this.select([], false);
  }

  note(text: string | null) {
    this.view.set({ note: text });
  }

  setPreview(p: SketchPreview | null) {
    this.view.set({ preview: p });
    this.state.set({ typing: !!p?.boxes.length });
  }

  // ------------------------------------------------------------ selection (sketch items)

  selected(): SketchHit[] {
    const f = this.feature;
    if (!f) return [];
    const out: SketchHit[] = [];
    for (const it of this.services.selection.get().items) if (it.kind === 'sketch' && it.feature === f) out.push({ what: it.what, id: it.id });
    return out;
  }

  /** Replace the sketch selection, or toggle these items (Ctrl). */
  select(hits: SketchHit[], additive: boolean) {
    const f = this.feature;
    if (!f) return;
    const items = hits.map((h): SelectionItem => ({ kind: 'sketch', feature: f, id: h.id, what: h.what }));
    this.services.selection.set((sel) => {
      if (!additive) return { ...sel, items };
      const key = (it: SelectionItem) => (it.kind === 'sketch' ? `${it.what}:${it.id}` : '');
      const have = new Set(sel.items.map(key));
      const toggled = items.filter((it) => have.has(key(it)));
      const keep = sel.items.filter((it) => !toggled.some((t) => key(t) === key(it)));
      return { ...sel, items: [...keep, ...items.filter((it) => !have.has(key(it)))] };
    });
  }

  setHover(h: SketchHit | null) {
    const cur = this.view.get().hover;
    if (cur?.id === h?.id && cur?.what === h?.what) return;
    this.view.set({ hover: h });
  }

  /** Drop selected items that are gone after an edit. */
  private pruneSelection(d: SketchFeature) {
    const f = this.feature;
    if (!f) return;
    const ok = (it: SelectionItem) => {
      if (it.kind !== 'sketch' || it.feature !== f) return true;
      if (it.what === 'point') return it.id === 'origin' || !!d.points[it.id];
      if (it.what === 'entity') return d.entities.some((e) => e.id === it.id);
      return d.constraints.some((c) => c.id === it.id);
    };
    const items = this.services.selection.get().items;
    if (!items.every(ok)) this.services.selection.set((sel) => ({ ...sel, items: sel.items.filter(ok) }));
  }

  // ------------------------------------------------------------ edits

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Wait for every queued edit (tests, Finish). */
  idle(): Promise<void> {
    return this.chain.then(() => {});
  }

  /**
   * One sketch edit: `make` builds the next geometry from the stored draft; the
   * solver solves it; a new over-definition drops `optional` constraints first,
   * then refuses (or reports, for "Make it driven?"); the solved draft is stored
   * (one sketch undo step) and analysed for the colours.
   */
  apply(label: string, make: (d: SketchFeature) => EditOutcome | SketchDraft | null, opts: ApplyOptions = {}): Promise<ApplyResult> {
    return this.enqueue(async () => {
      const s = this.session;
      const before = this.stored();
      if (!s || !s.open || !before) return { ok: false, reason: 'The sketch is closed' };
      let out: EditOutcome | SketchDraft | null;
      try {
        out = make(before);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.note(`${label} failed: ${reason}`);
        return { ok: false, reason };
      }
      if (!out) return { ok: false, reason: '' };
      if ('ok' in out && !out.ok) {
        this.note(`Not applied: ${out.reason}`);
        return { ok: false, reason: out.reason };
      }
      const draft = 'ok' in out ? out.draft : out;
      const optional = [...('ok' in out ? out.optional : []), ...(opts.optional ?? [])];
      const r = await this.solveEdit({ ...before, ...draft }, optional);
      if (!r.ok) {
        const reason = r.reason;
        if (opts.over === 'report' && r.over) return r;
        this.note(`Not applied: ${label} ${reason}`);
        await this.reload(before);
        return r;
      }
      this.commit(r.draft, !opts.noUndo);
      this.note(null);
      await this.analyze();
      return { ok: true, draft: r.draft };
    });
  }

  /** Solve a candidate; drop optional constraints that over-define it; report the outcome. */
  private async solveEdit(next: SketchFeature, optional: readonly string[]): Promise<ApplyResult> {
    const units = this.services.doc.units;
    const prevOver = new Set([...(this.view.get().status?.conflicting ?? []), ...(this.view.get().status?.redundant ?? [])]);
    let attempt = next;
    const drop = [...optional].reverse();
    for (;;) {
      const ev = evaluateDimensions(attempt, units);
      let r: SolverSolveResult;
      try {
        await this.solver.load(toSolverSketch(attempt, ev.values));
        r = await this.solver.solve();
      } catch (err) {
        return { ok: false, reason: `failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const st = statusOf(r);
      const fresh = [...st.conflicting, ...st.redundant].filter((id) => !prevOver.has(id));
      if (fresh.length && drop.length) {
        // Inferred and helper constraints go first, newest first, until nothing new over-defines.
        const id = drop.shift()!;
        attempt = { ...attempt, constraints: attempt.constraints.filter((c) => c.id !== id) };
        continue;
      }
      if (fresh.length) return { ok: false, reason: 'would over-define the sketch', over: true };
      if (!r.solved) return { ok: false, reason: 'cannot be solved: the constraints cannot all hold' };
      const solved = withSolved(attempt, r.values);
      // A solution that shrinks a line, a circle or an arc to nothing is not one (vertical on a horizontal line).
      const collapsed = collapsedBy(attempt, solved);
      if (collapsed) return { ok: false, reason: `would shrink ${entityLabel(attempt, collapsed)} to nothing` };
      this.lastSolve = r;
      return { ok: true, draft: { ...solved, solved: solvedStateOf(st, ev.values) } };
    }
  }

  /** Store a solved draft in the session (and on the sketch undo stack). */
  private commit(next: SketchFeature, undoable: boolean) {
    const s = this.session;
    if (!s || !s.open) return;
    const prev = this.stored();
    if (undoable && prev) {
      this.undoStack.push(snapshot(prev));
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    // P4b (SELECT): the links, pruned to the entities still there (a deleted projected curve leaves its link).
    s.update({ points: next.points, entities: next.entities, constraints: next.constraints, solved: next.solved, links: prunedLinks(next), ties: prunedTies(next) } as Partial<SketchFeature>);
    const d = this.stored() ?? next;
    this.view.set({ draft: d, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
    this.pruneSelection(d);
  }

  /** Load a stored draft into the solver again (after a refused edit) and solve it in place. */
  private async reload(d: SketchFeature) {
    try {
      const ev = evaluateDimensions(d, this.services.doc.units);
      await this.solver.load(toSolverSketch(d, ev.values));
      this.lastSolve = await this.solver.solve();
    } catch {
      /* the next edit loads again */
    }
  }

  /** Analyse the sketch loaded in the solver: per-entity colours and the status. */
  private async analyze() {
    this.state.set({ analyzing: true });
    try {
      const a = await this.solver.analyze();
      const status = statusOf(this.lastSolve, a);
      this.view.set({ analysis: a, status });
      this.state.set({ status, analyzing: false });
      // The stored state follows the analysis (tree prefix, chip after reopening).
      // An under-defined sketch also keeps which entities are fully defined: model mode colours them so.
      const d = this.stored();
      const fully = status.state === 'under' ? d?.entities.filter((e) => a.perEntity[e.id] === 'fully').map((e) => e.id) : undefined;
      if (d && this.session?.open && (d.solved.state !== status.state || d.solved.dof !== status.dof || (d.solved.fully ?? []).join() !== (fully ?? []).join())) {
        const solved: SketchFeature['solved'] = { ...d.solved, state: status.state, dof: status.dof };
        if (fully?.length) solved.fully = fully;
        else delete solved.fully;
        this.session.update({ solved } as Partial<SketchFeature>);
        this.view.set({ draft: this.stored() });
      }
    } catch (err) {
      this.state.set({ analyzing: false });
      const status = statusOf(this.lastSolve, null);
      this.view.set({ status });
      this.state.set({ status });
      this.note(`The sketch could not be analysed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** On entering: what is stored, solved again when a parameter changed a dimension. */
  private async settleStored() {
    const d = this.stored();
    if (!d) return;
    const ev = evaluateDimensions(d, this.services.doc.units);
    const same = Object.keys(ev.values).length === Object.keys(d.solved.values ?? {}).length && Object.entries(ev.values).every(([k, v]) => sameValue(v, d.solved.values[k]));
    try {
      await this.solver.load(toSolverSketch(d, ev.values));
      const r = await this.solver.solve();
      this.lastSolve = r;
      if (!same && r.solved) {
        const st = statusOf(r);
        this.commit({ ...withSolved(d, r.values), solved: solvedStateOf(st, ev.values) }, false);
      }
    } catch (err) {
      this.note(`The sketch solver is not running: ${err instanceof Error ? err.message : String(err)}`);
      const status = statusOf(null, null);
      this.view.set({ status });
      this.state.set({ status });
      return;
    }
    await this.analyze();
  }

  undo(): void {
    void this.enqueue(async () => {
      const prev = this.undoStack.pop();
      const cur = this.stored();
      if (!prev || !cur || !this.session?.open) return;
      this.redoStack.push(snapshot(cur));
      this.session.update(prev as Partial<SketchFeature>);
      const d = this.stored()!;
      this.view.set({ draft: d, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, preview: null });
      this.pruneSelection(d);
      await this.reload(d);
      await this.analyze();
    });
  }

  redo(): void {
    void this.enqueue(async () => {
      const next = this.redoStack.pop();
      const cur = this.stored();
      if (!next || !cur || !this.session?.open) return;
      this.undoStack.push(snapshot(cur));
      this.session.update(next as Partial<SketchFeature>);
      const d = this.stored()!;
      this.view.set({ draft: d, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, preview: null });
      this.pruneSelection(d);
      await this.reload(d);
      await this.analyze();
    });
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  // ------------------------------------------------------------ deleting

  /** Delete the selected sketch items (with what depends on them). */
  deleteSelected(): Promise<ApplyResult> | null {
    const hits = this.selected();
    if (!hits.length) return null;
    const ids = hits.map((h) => h.id).filter((id) => id !== 'origin');
    if (!ids.length) return null;
    // P4b fix 1 (SKETCH, P6): a pattern or offset whose sources go is dissolved; the panel says so.
    const before = this.stored();
    return this.apply('Delete', (d) => {
      const b = new SketchBuilder(d);
      b.remove(ids);
      return { ok: true, draft: b.result(), optional: [], removed: ids };
    }).then((r) => {
      if (r.ok) this.select([], false);
      const lost = r.ok && before ? tiesDissolved(before, this.stored() ?? before) : null;
      if (lost) this.note(lost);
      return r;
    });
  }

  // ------------------------------------------------------------ dimensions

  /**
   * Place a dimension (driving, at the value it measures): when it would
   * over-define the sketch, ask "Make it driven?" and place it driven instead.
   * Resolves with its id, or null when it was not placed.
   */
  async placeDimension(kind: SketchConstraint['kind'], refs: string[], at: Vec2): Promise<string | null> {
    const d = this.stored();
    if (!d || !isDimensionKind(kind)) return null;
    const value = measureDimension(d, { kind, refs });
    if (value == null) return null;
    const units = this.services.doc.units;
    // Horizontal, vertical and angle dimensions are signed (their references are ordered to make them positive).
    const signed = kind === 'distance_x' || kind === 'distance_y' || kind === 'angle';
    const expr = exprFor(signed ? value : Math.abs(value), quantityOf(kind), units);
    let id = '';
    const r = await this.apply(
      DIMENSION_LABELS[kind],
      (cur) => {
        const b = new SketchBuilder(cur);
        id = b.addDimension(kind, refs, expr, { at });
        return b.result();
      },
      { over: 'report' },
    );
    if (r.ok) return id;
    if (!r.over) return null;
    const label = `${DIMENSION_LABELS[kind]} ${units.format(Math.abs(value), quantityOf(kind), { digits: 2 })}`;
    const yes = await this.ask({
      title: 'Make it driven?',
      copy: `${label} would over-define ${this.stored()?.name ?? 'the sketch'}. A driven dimension shows the value without holding it.`,
      accept: 'Make it driven',
    });
    if (!yes) {
      // The refused try left the solver on the candidate: load the stored sketch again.
      await this.enqueue(async () => {
        const cur = this.stored();
        if (cur) await this.reload(cur);
      });
      return null;
    }
    const r2 = await this.apply(DIMENSION_LABELS[kind], (cur) => {
      const b = new SketchBuilder(cur);
      id = b.addDimension(kind, refs, expr, { at, driving: false });
      return b.result();
    });
    return r2.ok ? id : null;
  }

  private ask(p: { title: string; copy: string; accept: string }): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (yes: boolean) => {
        if (this.view.get().prompt?.resolve === done) this.view.set({ prompt: null });
        resolve(yes);
      };
      this.view.set({ prompt: { ...p, resolve: done } });
    });
  }

  /**
   * A dimension's new expression (typed in its value box). The first driving
   * length dimension of a sketch scales the whole sketch to it first, so a
   * rough drawing keeps its shape (proposal §2.2).
   */
  setDimension(id: string, text: string): Promise<ApplyResult> {
    const d = this.stored();
    const c = d?.constraints.find((x) => x.id === id);
    if (!d || !c || !isDimension(c)) return Promise.resolve({ ok: false, reason: 'That dimension is gone' });
    const units = this.services.doc.units;
    const q = quantityOf(c.kind);
    const trimmed = text.trim();
    const r = units.evaluate(trimmed, q);
    if (!r.ok) {
      this.note(`Not applied: ${r.error}`);
      return Promise.resolve({ ok: false, reason: r.error });
    }
    if ((c.kind === 'radius' || c.kind === 'diameter' || c.kind === 'distance') && !(r.value > 0)) {
      this.note('Not applied: a distance must be more than 0');
      return Promise.resolve({ ok: false, reason: 'a distance must be more than 0' });
    }
    const expr = storeExpr(trimmed, q, units);
    return this.apply(`${DIMENSION_LABELS[c.kind]} ${expr}`, (cur) => {
      const b = new SketchBuilder(cur);
      const dim = cur.constraints.find((x) => x.id === id);
      if (!dim || !isDimension(dim)) return { ok: false, reason: 'that dimension is gone' };
      const others = cur.constraints.filter((x) => isDimension(x) && x.driving && x.id !== id && quantityOf(x.kind) === 'length');
      if (!dim.driving) return { ok: false, reason: 'a driven dimension only shows a value: make it driving to set it' };
      if (q === 'length' && !others.length) {
        const now = measureDimension(cur, dim);
        if (now && Math.abs(now) > 1e-12 && r.value / Math.abs(now) > 0) {
          const k = r.value / Math.abs(now);
          for (const p of Object.keys(b.points)) b.points[p] = [b.points[p][0] * k, b.points[p][1] * k];
          b.entities = b.entities.map((e) => (e.kind === 'circle' ? { ...e, r: e.r * k } : e));
          b.constraints = b.constraints.map((x) => (isDimension(x) && x.at ? { ...x, at: [x.at[0] * k, x.at[1] * k] as Vec2 } : x));
        }
      }
      b.constraints = b.constraints.map((x) => (x.id === id ? { ...(x as typeof dim), expr } : x));
      return b.result();
    });
  }

  /** Driven <-> driving. Making it driving is refused when it would over-define the sketch. */
  toggleDriving(id: string): Promise<ApplyResult> {
    const d = this.stored();
    const c = d?.constraints.find((x) => x.id === id);
    if (!d || !c || !isDimension(c)) return Promise.resolve({ ok: false, reason: 'That dimension is gone' });
    const units = this.services.doc.units;
    return this.apply(c.driving ? 'Make driven' : 'Make driving', (cur) => {
      const b = new SketchBuilder(cur);
      b.constraints = b.constraints.map((x) => {
        if (x.id !== id || !isDimension(x)) return x;
        if (x.driving) return { ...x, driving: false };
        // Driving again at the value it shows now.
        const v = measureDimension(cur, x);
        return { ...x, driving: true, expr: v == null ? x.expr : exprFor(v, quantityOf(x.kind), units) };
      });
      return b.result();
    });
  }

  /** Move a dimension's label (one undo step). */
  moveLabel(id: string, at: Vec2): Promise<ApplyResult> {
    return this.apply('Move dimension', (cur) => {
      const b = new SketchBuilder(cur);
      b.constraints = b.constraints.map((x) => (x.id === id && isDimension(x) ? { ...x, at: [at[0], at[1]] as Vec2 } : x));
      return b.result();
    });
  }

  // ------------------------------------------------------------ drags

  /**
   * Start dragging a point or a whole entity. Refused (false) when it cannot
   * move: fully defined, or the sketch is over-defined.
   */
  beginDrag(target: { point: string } | { entity: string; grab: Vec2 }): Promise<boolean> {
    return this.enqueue(async () => {
      const d = this.stored();
      if (!d || !this.session?.open) return false;
      try {
        const ev = evaluateDimensions(d, this.services.doc.units);
        await this.solver.load(toSolverSketch(d, ev.values));
        const r = 'point' in target ? await this.solver.dragStart(target.point) : await this.solver.dragStartEntity(target.entity, target.grab);
        if (!r.ok || !r.movable) {
          await this.solver.dragEnd().catch(() => null);
          const what = 'point' in target ? 'point' : (entityOf(d, target.entity)?.kind ?? 'entity');
          // Follow-up (Daniel, 2026-10-06): no not-allowed cursor; the words say why and what to do.
          this.note(r.ok ? `This ${what} is fully defined: change a dimension to move it` : 'The sketch is over-defined: fix the conflict before dragging');
          return false;
        }
      } catch (err) {
        this.note(`Drag failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      this.drag = { base: d, moved: false };
      this.view.set({ dragging: true });
      return true;
    });
  }

  /** A drag move (coalesced in the worker: superseded moves are skipped). */
  dragTo(uv: Vec2) {
    if (!this.drag) return;
    const base = this.drag.base;
    void this.solver
      .dragMove(uv[0], uv[1])
      .then((r) => {
        if (!this.drag || r.superseded || !r.values) return;
        this.drag.moved = true;
        this.view.set({ draft: { ...withSolved(base, r.values) } });
      })
      .catch(() => {});
  }

  /** End the drag: solved once more and stored (one sketch undo step). */
  endDrag(): Promise<void> {
    const drag = this.drag;
    if (!drag) return Promise.resolve();
    return this.enqueue(async () => {
      this.drag = null;
      this.view.set({ dragging: false });
      try {
        const r = await this.solver.dragEnd();
        this.lastSolve = r;
        if (!drag.moved || !r.solved) {
          this.view.set({ draft: this.stored() });
          if (drag.moved && !r.solved) this.note('Not applied: the sketch could not be solved after that drag');
          return;
        }
        const ev = evaluateDimensions(drag.base, this.services.doc.units);
        const st = statusOf(r);
        this.commit({ ...withSolved(drag.base, r.values), solved: solvedStateOf(st, ev.values) }, true);
        await this.analyze();
      } catch (err) {
        this.view.set({ draft: this.stored() });
        this.note(`Drag failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  get dragging(): boolean {
    return !!this.drag;
  }

  dispose() {
    for (const off of this.offs.splice(0)) off();
    if (this.session) this.leave();
    controllers.delete(this.services);
  }

  /** Words for a constraint (panels). */
  describe(c: SketchConstraint): string {
    const d = this.draft();
    return d ? constraintLabel(d, c, this.services.doc.units) : c.kind;
  }
}

/** The first line, circle or arc the solved geometry shrank to nothing (that had a size before), or null. */
export function collapsedBy(before: SketchFeature, after: SketchFeature): string | null {
  const size = (d: SketchFeature, id: string): number => {
    const e = entityOf(d, id);
    if (!e) return 0;
    if (e.kind === 'line') {
      const a = d.points[e.p[0]] ?? (e.p[0] === 'origin' ? [0, 0] : null);
      const b = d.points[e.p[1]] ?? (e.p[1] === 'origin' ? [0, 0] : null);
      return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
    }
    if (e.kind === 'circle') return e.r;
    if (e.kind === 'arc') {
      const c = d.points[e.c] ?? [0, 0];
      const a = d.points[e.a] ?? [0, 0];
      return Math.hypot(a[0] - c[0], a[1] - c[1]);
    }
    return 1;
  };
  let scale = 0;
  for (const p of Object.values(before.points)) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const tiny = 1e-7 * Math.max(1, scale);
  for (const e of after.entities) {
    if (e.kind === 'point') continue;
    if (size(after, e.id) <= tiny && size(before, e.id) > tiny) return e.id;
  }
  return null;
}

function isDimensionKind(k: string): k is import('../types/doc').SketchDimensionKind {
  return ['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle'].includes(k);
}

function sameValue(a: number, b: number | undefined): boolean {
  if (b == null) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function samePlane(a: PlaneFrame, b: PlaneFrame | null): boolean {
  if (!b) return false;
  const eq = (x: Vec3, y: Vec3) => x.every((v, i) => Math.abs(v - y[i]) < 1e-12);
  return eq(a.origin, b.origin) && eq(a.normal, b.normal) && eq(a.xdir, b.xdir);
}

/** A value (mm / deg) as an expression in the document's display unit, rounded to what a user would type (6 significant digits). */
export function exprFor(value: number, q: 'length' | 'angle', units: AppServices['doc']['units']): string {
  const u = units.units();
  if (q === 'angle') {
    return u.angle === 'rad' ? `${round6((value * Math.PI) / 180)} rad` : `${round6(value)} deg`;
  }
  const per = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 }[u.length];
  return `${round6(value / per)} ${u.length}`;
}

function round6(v: number): string {
  return String(Number(v.toPrecision(6)));
}

/** What a typed value box stores: a bare number takes the display unit ("40" -> "40 mm"); anything else as typed. */
export function storeExpr(text: string, q: 'length' | 'angle', units: AppServices['doc']['units']): string {
  if (/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(text)) {
    const u = units.units();
    return `${text.trim()} ${q === 'angle' ? (u.angle === 'rad' ? 'rad' : 'deg') : u.length}`;
  }
  return text.trim();
}

/**
 * The frame of a sketch on a planar face (docs/p2p3-plan.md §1.7): the global
 * origin projected on the face's plane, the face's outward normal, and global X
 * projected on the plane (Y when X is within 1 degree of the normal).
 */
export function faceFrame(normal: Vec3, onPlane: Vec3): PlaneFrame {
  const l = Math.hypot(...normal);
  const n: Vec3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  const d = n[0] * onPlane[0] + n[1] * onPlane[1] + n[2] * onPlane[2];
  const origin: Vec3 = [n[0] * d, n[1] * d, n[2] * d];
  const pick: Vec3 = Math.abs(n[0]) > Math.cos(Math.PI / 180) ? [0, 1, 0] : [1, 0, 0];
  const k = pick[0] * n[0] + pick[1] * n[1] + pick[2] * n[2];
  const x: Vec3 = [pick[0] - k * n[0], pick[1] - k * n[1], pick[2] - k * n[2]];
  const xl = Math.hypot(...x);
  return { origin, normal: n, xdir: [x[0] / xl, x[1] / xl, x[2] / xl] };
}
