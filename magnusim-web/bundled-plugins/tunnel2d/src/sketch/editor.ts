// The sketch editor: edits one sketch body in place in the tunnel while the flow runs. The
// Viewport hands it the pointer and keys and lets it draw on the overlay; the toolbar
// (src/ui/sketchbar.tsx) picks its tool and applies relations. Every change goes through the
// solver and lands in the scene (so the body in the flow follows at once); a finished
// gesture is one undo step. Coordinates: the sketch's mm, origin at the body's pivot, turned
// with the body.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Store } from '../app/store';
import type { Body, Scene } from '../scene/scene';
import type { Engine } from '../sim/engine';
import { profileOf } from '../geometry/shapes';
import {
  arcGeom,
  colourOf,
  distanceTo,
  formatDimNumber,
  isDimension,
  layoutDimension,
  measureDimension,
  overIds,
  planDimension,
  pointIdOf,
  splineSamples,
  statusText,
  GLYPH_ICON,
  type SketchConstraint,
  type SketchDimension,
  type SketchEntity,
  type SketchRelationKind,
  type Vec2,
} from './cad';
import { addArc3, addCircle, addDimension, addLineInferred, addPointEntity, addRectangle, addRelation, addSpline, clone, deleteItems, fillet, placePoint, toggleConstruction } from './edit';
import { emptySketch, evalValue, exprOf, type SketchData } from './model';
import type { SketchSolver, SketchStatus } from './solve';
import type { SolverAnalysis } from './cad';

export type SketchTool = 'select' | 'line' | 'rectangle' | 'circle' | 'arc' | 'spline' | 'point' | 'fillet' | 'dimension';

export const TOOL_LABELS: Record<SketchTool, string> = {
  select: 'Select',
  line: 'Line',
  rectangle: 'Rectangle',
  circle: 'Circle',
  arc: 'Arc',
  spline: 'Spline',
  point: 'Point',
  fillet: 'Fillet',
  dimension: 'Dimension',
};

/** Relations the toolbar offers on the selection. */
export const RELATIONS: SketchRelationKind[] = ['coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal', 'concentric', 'fix'];

const PICK_POINT_PX = 9;
const PICK_CURVE_PX = 7;

export interface Palette {
  under: string;
  fully: string;
  over: string;
  construction: string;
  pick: string;
  halo: string;
  preview: string;
  /** Under the marks with no halo of their own (the origin, the rings where the outline is open, the snap ring) where they need one (dark). */
  markHalo?: string;
}

type Listener = () => void;

export class SketchEditor {
  /** The body being edited (null: not editing). */
  bodyId: string | null = null;
  tool: SketchTool = 'line';
  selection: string[] = [];
  status: SketchStatus | null = null;
  analysis: SolverAnalysis | null = null;
  /** The last thing worth telling: a refused relation, a fillet that does not fit. */
  message = '';
  busy = false;
  /** A dimension's value being typed (its id, where its label is in CSS px, the text). */
  editingDim: { id: string; x: number; y: number; text: string } | null = null;

  private store: Store;
  private engine: Engine;
  private solverOf: () => SketchSolver;
  private listeners = new Set<Listener>();
  /** Points clicked so far by the drawing tool (local mm, and the point they snapped to). */
  private clicks: { p: Vec2; snap: string | null }[] = [];
  /** The line tool's chain: the point the next line starts from, and where the chain began. */
  private chain: { from: string; first: string; before: Scene } | null = null;
  private cursor: Vec2 | null = null;
  private cursorSnap: string | null = null;
  private hover: string | null = null;
  private dimPicks: string[] = [];
  private drag: { point: string; before: Scene; moved: boolean } | null = null;
  private solveSeq = 0;

  constructor(store: Store, engine: Engine, solverOf: () => SketchSolver) {
    this.store = store;
    this.engine = engine;
    this.solverOf = solverOf;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Bumped on every change the toolbar shows (for useSyncExternalStore). */
  version = 0;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------ the body and its sketch

  get body(): Body | null {
    return this.store.get().scene.bodies.find((b) => b.id === this.bodyId && b.shape.kind === 'sketch') ?? null;
  }

  get sketch(): SketchData {
    const b = this.body;
    return b && b.shape.kind === 'sketch' ? b.shape.sketch : emptySketch();
  }

  /** The scene with this body's sketch replaced. */
  private withSketch(scene: Scene, s: SketchData): Scene {
    return { ...scene, bodies: scene.bodies.map((b) => (b.id === this.bodyId && b.shape.kind === 'sketch' ? { ...b, shape: { ...b.shape, sketch: s } } : b)) };
  }

  open(bodyId: string, tool: SketchTool = 'select') {
    this.bodyId = bodyId;
    this.tool = tool;
    this.reset();
    this.store.select(bodyId);
    this.emit();
    // Its status (and the solver's start) now.
    void this.solveAndCommit(this.sketch, null);
  }

  close() {
    this.reset();
    this.bodyId = null;
    this.editingDim = null;
    this.emit();
  }

  /**
   * The scene changed under the editor (undo, redo): drop what was half drawn and solve again
   * for the status. Closes when the body is gone or no longer a sketch.
   */
  resync() {
    if (!this.bodyId) return;
    if (!this.body) return this.close();
    this.clicks = [];
    this.chain = null;
    this.dimPicks = [];
    this.drag = null;
    const ids = new Set([...Object.keys(this.sketch.points), ...this.sketch.entities.map((e) => e.id), ...this.sketch.constraints.map((c) => c.id)]);
    this.selection = this.selection.filter((id) => ids.has(id));
    void this.solveAndCommit(this.sketch, null);
  }

  get editing(): boolean {
    return !!this.body;
  }

  setTool(t: SketchTool) {
    this.tool = t;
    this.reset();
    this.emit();
  }

  private reset() {
    this.clicks = [];
    this.chain = null;
    this.dimPicks = [];
    this.message = '';
    if (this.tool !== 'select') this.selection = [];
  }

  // ------------------------------------------------------------ coordinates

  private pose() {
    const b = this.body!;
    return { x: b.x, y: b.y, theta: (-b.angle * Math.PI) / 180 };
  }

  /** World metres to sketch mm. */
  toLocal(wx: number, wy: number): Vec2 {
    const q = this.pose();
    const dx = wx - q.x;
    const dy = wy - q.y;
    const c = Math.cos(q.theta);
    const s = Math.sin(q.theta);
    return [(c * dx + s * dy) * 1000, (-s * dx + c * dy) * 1000];
  }

  /** Sketch mm to world metres. */
  toWorld(p: Vec2): { x: number; y: number } {
    const q = this.pose();
    const c = Math.cos(q.theta);
    const s = Math.sin(q.theta);
    const x = p[0] / 1000;
    const y = p[1] / 1000;
    return { x: q.x + c * x - s * y, y: q.y + s * x + c * y };
  }

  /** mm per CSS pixel now. */
  private mmPerPx(): number {
    return this.engine.worldView.mpp * 1000;
  }

  // ------------------------------------------------------------ picking

  /** The point (or the origin) under a screen spot. */
  private pickPoint(local: Vec2, exclude: string | null = null): string | null {
    const s = this.sketch;
    const tol = PICK_POINT_PX * this.mmPerPx();
    let best: string | null = null;
    let bd = tol;
    if (Math.hypot(local[0], local[1]) <= bd) {
      best = 'origin';
      bd = Math.hypot(local[0], local[1]);
    }
    for (const [id, p] of Object.entries(s.points)) {
      if (id === exclude) continue;
      const d = Math.hypot(p[0] - local[0], p[1] - local[1]);
      if (d <= bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  private pickEntity(local: Vec2): string | null {
    const s = this.sketch;
    const tol = PICK_CURVE_PX * this.mmPerPx();
    let best: string | null = null;
    let bd = tol;
    for (const e of s.entities) {
      if (e.kind === 'point') continue;
      const d = distanceTo(s, e, local);
      if (d <= bd) {
        bd = d;
        best = e.id;
      }
    }
    return best;
  }

  /** The dimension whose label is under a screen spot (CSS px). */
  private pickDimension(screen: { x: number; y: number }, toScreen: (x: number, y: number) => { x: number; y: number }): string | null {
    for (const c of this.sketch.constraints) {
      if (!isDimension(c)) continue;
      const lay = layoutDimension(this.sketch, c, this.mmPerPx());
      if (!lay) continue;
      const w = this.toWorld(lay.text);
      const t = toScreen(w.x, w.y);
      if (Math.abs(screen.x - t.x) <= 30 && Math.abs(screen.y - t.y) <= 10) return c.id;
    }
    return null;
  }

  // ------------------------------------------------------------ committing

  private async solveAndCommit(next: SketchData, before: Scene | null): Promise<boolean> {
    const seq = ++this.solveSeq;
    this.busy = true;
    this.emit();
    // Shown at once (the flow sees it too), then put right by the solver.
    if (before) this.store.commit(this.withSketch(this.store.get().scene, next), false);
    const r = await this.solverOf().solve(next);
    if (seq !== this.solveSeq || !this.editing) return false;
    // Drawn on meanwhile (a line chain, a drag: those land unsolved): this answer is stale.
    if (this.sketch !== next) {
      this.busy = false;
      this.emit();
      return false;
    }
    this.busy = false;
    if (r.error) {
      // Refused: back to how it was, with the reason.
      if (before) this.store.commit(before, false);
      this.message = r.error;
      this.emit();
      return false;
    }
    this.status = r.status;
    this.analysis = r.analysis;
    const after = this.withSketch(this.store.get().scene, r.sketch);
    if (before) this.store.commitFrom(before, after);
    else this.store.commit(after, false);
    this.emit();
    return true;
  }

  /** Apply an edit to the sketch (an undo step once solved). */
  private edit(fn: (s: SketchData) => void | SketchData): Promise<boolean> {
    const before = this.store.get().scene;
    const s = clone(this.sketch);
    const out = fn(s) ?? s;
    return this.solveAndCommit(out, before);
  }

  // ------------------------------------------------------------ toolbar actions

  /** A relation on the selection (the solver refuses one that does not fit, and says why). */
  applyRelation(kind: SketchRelationKind) {
    const sel = this.selection.filter((id) => !this.sketch.constraints.some((c) => c.id === id));
    if (!sel.length) {
      this.message = 'Select the points or curves first (Select tool, Shift adds to the selection).';
      this.emit();
      return;
    }
    void this.edit((s) => {
      addRelation(s, kind, sel);
    }).then((ok) => {
      if (!ok) this.message = `A ${kind.replace('_', ' ')} relation does not fit those: ${this.message}`;
      this.emit();
    });
  }

  toggleConstruction() {
    if (!this.selection.length) return;
    const before = this.store.get().scene;
    void this.solveAndCommit(toggleConstruction(this.sketch, this.selection), before);
  }

  deleteSelection() {
    if (!this.selection.length) return;
    const before = this.store.get().scene;
    const next = deleteItems(this.sketch, this.selection);
    this.selection = [];
    void this.solveAndCommit(next, before);
  }

  /** A dimension's value typed in (an expression with units). */
  setDimension(id: string, text: string): string | null {
    const c = this.sketch.constraints.find((x) => x.id === id);
    if (!c || !isDimension(c)) return 'That dimension is gone.';
    const q = c.kind === 'angle' ? 'angle' : 'length';
    const r = evalValue(text, q);
    if ('error' in r) return r.error;
    this.editingDim = null;
    void this.edit((s) => {
      const d = s.constraints.find((x) => x.id === id) as SketchDimension;
      d.expr = exprOf(r.value, q);
      d.driving = true;
    });
    return null;
  }

  startDimensionEdit(id: string, x: number, y: number) {
    const c = this.sketch.constraints.find((k) => k.id === id);
    if (!c || !isDimension(c)) return;
    const v = measureDimension(this.sketch, c);
    this.editingDim = { id, x, y, text: v == null ? '' : formatDimNumber(v) };
    this.emit();
  }

  cancelDimensionEdit() {
    if (!this.editingDim) return;
    this.editingDim = null;
    this.emit();
  }

  /** Where each dimension's label is drawn (screen, through `toScreen`), with its value. */
  dimensionLabels(toScreen: (x: number, y: number) => { x: number; y: number }): { id: string; kind: string; x: number; y: number; value: number | null }[] {
    const out = [];
    for (const c of this.sketch.constraints) {
      if (!isDimension(c)) continue;
      const lay = layoutDimension(this.sketch, c, this.mmPerPx());
      if (!lay) continue;
      const w = this.toWorld(lay.text);
      out.push({ id: c.id, kind: c.kind, ...toScreen(w.x, w.y), value: measureDimension(this.sketch, c) });
    }
    return out;
  }

  /** The words for the status chip. */
  statusWords(): string {
    if (this.busy) return 'Solving…';
    const p = profileOf(this.sketch);
    if (!this.sketch.entities.length) return 'Draw a closed outline';
    const def = statusText(this.status as never, false);
    if (!p.rings.length) return `${def} · not closed: the body is not in the flow`;
    return def;
  }

  // ------------------------------------------------------------ input

  /**
   * A press at world (wx, wy) / screen (CSS px). `toScreen` maps world to CSS px; `clicks` is
   * the event's click count. True when the editor used it.
   */
  pointerDown(wx: number, wy: number, screen: { x: number; y: number }, opts: { shift: boolean; clicks: number }, toScreen: (x: number, y: number) => { x: number; y: number }): boolean {
    if (!this.editing) return false;
    const local = this.toLocal(wx, wy);
    const snap = this.pickPoint(local);
    const at: Vec2 = snap && snap !== 'origin' ? this.sketch.points[snap] : snap === 'origin' ? [0, 0] : local;
    this.message = '';
    switch (this.tool) {
      case 'select': {
        const dim = this.pickDimension(screen, toScreen);
        if (dim && opts.clicks >= 2) {
          this.startDimensionEdit(dim, screen.x, screen.y);
          return true;
        }
        const id = dim ?? (snap !== 'origin' ? snap : null) ?? this.pickEntity(local);
        if (!id) {
          this.selection = [];
          this.emit();
          return true;
        }
        this.selection = opts.shift ? (this.selection.includes(id) ? this.selection.filter((x) => x !== id) : [...this.selection, id]) : [id];
        // A point (not the origin) drags.
        if (snap && snap !== 'origin' && id === snap) {
          this.drag = { point: snap, before: this.store.get().scene, moved: false };
          void this.solverOf()
            .dragStart(this.sketch, snap)
            .then((ok) => {
              if (!ok && this.drag) {
                this.message = 'That point cannot move: its relations and dimensions hold it.';
                this.drag = null;
                this.emit();
              }
            });
        }
        this.emit();
        return true;
      }
      case 'point':
        void this.edit((s) => {
          addPointEntity(s, placePoint(s, at, snap));
        });
        return true;
      case 'line': {
        if (!this.chain) {
          const before = this.store.get().scene;
          const s = clone(this.sketch);
          const id = placePoint(s, at, snap);
          this.store.commit(this.withSketch(this.store.get().scene, s), false);
          this.chain = { from: id, first: id, before };
          this.emit();
          return true;
        }
        const s = clone(this.sketch);
        // Back on the chain's first point closes it and ends the chain.
        const target = snap ?? null;
        if (target === this.chain.from) {
          // A double-click on the chain's last point ends the chain there.
          if (opts.clicks >= 2) this.key('Escape');
          return true;
        }
        const to = placePoint(s, at, target);
        addLineInferred(s, this.chain.from, to);
        const closes = to === this.chain.first;
        const before = this.chain.before;
        this.chain = closes || opts.clicks >= 2 ? null : { from: to, first: this.chain.first, before };
        if (!this.chain) void this.solveAndCommit(s, before);
        else this.store.commit(this.withSketch(this.store.get().scene, s), false);
        this.emit();
        return true;
      }
      case 'rectangle':
      case 'circle': {
        this.clicks.push({ p: at, snap });
        if (this.clicks.length < 2) return this.emitTrue();
        const [a, b] = this.clicks;
        this.clicks = [];
        if (this.tool === 'rectangle') {
          if (Math.abs(b.p[0] - a.p[0]) < 1e-6 || Math.abs(b.p[1] - a.p[1]) < 1e-6) return this.emitTrue();
          void this.edit((s) => {
            addRectangle(s, a.p, b.p, a.snap);
          });
        } else {
          const r = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]);
          if (r < 1e-6) return this.emitTrue();
          void this.edit((s) => {
            addCircle(s, a.p, r, a.snap);
          });
        }
        return true;
      }
      case 'arc': {
        // Start, end, then a point it passes through.
        this.clicks.push({ p: at, snap });
        if (this.clicks.length < 3) return this.emitTrue();
        const [a, b, m] = this.clicks;
        this.clicks = [];
        void this.edit((s) => {
          const pa = placePoint(s, a.p, a.snap);
          const pb = placePoint(s, b.p, b.snap);
          if (!addArc3(s, pa, pb, m.p)) this.message = 'Those three points are in line: no arc goes through them.';
        });
        return true;
      }
      case 'spline': {
        // Click points; a double-click (or Enter) ends it.
        // The second click of a double-click lands on the first's point: not a new one.
        const last = this.clicks[this.clicks.length - 1];
        const again = opts.clicks >= 2 && last && Math.hypot(last.p[0] - at[0], last.p[1] - at[1]) <= PICK_POINT_PX * this.mmPerPx();
        if (!again) this.clicks.push({ p: at, snap });
        if (opts.clicks >= 2 && this.clicks.length >= 2) this.finishSpline();
        else this.emit();
        return true;
      }
      case 'fillet': {
        const p = snap && snap !== 'origin' ? snap : null;
        if (!p) {
          this.message = 'Click a corner where two lines meet.';
          return this.emitTrue();
        }
        // A radius a fifth of the shorter line, to two figures (the dimension it gets sets it after).
        const s0 = this.sketch;
        const lens = s0.entities
          .filter((e): e is Extract<SketchEntity, { kind: 'line' }> => e.kind === 'line' && e.p.includes(p))
          .map((e) => Math.hypot(s0.points[e.p[1]][0] - s0.points[e.p[0]][0], s0.points[e.p[1]][1] - s0.points[e.p[0]][1]));
        const r = Math.max(1e-3, Number((0.2 * Math.min(...lens, Infinity)).toPrecision(2)));
        void this.edit((s) => {
          const out = fillet(s, p, Number.isFinite(r) ? r : 1);
          if (!out.ok) this.message = out.reason;
        });
        return true;
      }
      case 'dimension': {
        // Pick the geometry, then click where the label goes.
        const pick = (snap !== 'origin' ? snap : null) ?? this.pickEntity(local);
        if (pick) {
          this.dimPicks = this.dimPicks.includes(pick) ? this.dimPicks : [...this.dimPicks, pick].slice(-2);
          return this.emitTrue();
        }
        if (!this.dimPicks.length) {
          this.message = 'Pick a line, a circle, an arc, or two points or lines, then click where the dimension goes.';
          return this.emitTrue();
        }
        const plan = planDimension(this.sketch, this.dimPicks, local);
        this.dimPicks = [];
        if ('reason' in plan) {
          this.message = plan.reason;
          return this.emitTrue();
        }
        void this.edit((s) => {
          addDimension(s, plan.kind, plan.refs, plan.value, local);
        });
        return true;
      }
    }
    return false;
  }

  private emitTrue(): true {
    this.emit();
    return true;
  }

  pointerMove(wx: number, wy: number): boolean {
    if (!this.editing) return false;
    const local = this.toLocal(wx, wy);
    if (this.drag) {
      this.drag.moved = true;
      const before = this.sketch;
      void this.solverOf()
        .dragMove(before, local[0], local[1])
        .then((s) => {
          if (s && this.drag) this.store.commit(this.withSketch(this.store.get().scene, s), false);
        });
      return true;
    }
    this.cursorSnap = this.pickPoint(local, this.chain?.from ?? null);
    this.cursor = this.cursorSnap === 'origin' ? [0, 0] : this.cursorSnap ? this.sketch.points[this.cursorSnap] : local;
    this.hover = this.cursorSnap && this.cursorSnap !== 'origin' ? this.cursorSnap : this.pickEntity(local);
    return true;
  }

  pointerUp(): boolean {
    if (!this.editing) return false;
    const d = this.drag;
    this.drag = null;
    if (d) {
      const s = this.sketch;
      void this.solverOf()
        .dragEnd(s)
        .then((r) => {
          if (!this.editing) return;
          this.status = r.status;
          this.analysis = r.analysis;
          const after = this.withSketch(this.store.get().scene, r.sketch);
          if (d.moved) this.store.commitFrom(d.before, after);
          else this.store.commit(after, false);
          this.emit();
        });
    }
    return true;
  }

  private finishSpline() {
    const pts = this.clicks;
    this.clicks = [];
    if (pts.length < 2) return this.emit();
    void this.edit((s) => {
      const ids = pts.map((c) => placePoint(s, c.p, c.snap));
      const closed = ids.length >= 4 && ids[0] === ids[ids.length - 1];
      addSpline(s, closed ? ids.slice(0, -1) : ids, closed);
    });
  }

  /** A key while editing: Escape ends what is being drawn (then leaves), Enter finishes a spline or chain, Delete deletes. */
  key(k: string): boolean {
    if (!this.editing) return false;
    if (k === 'Escape') {
      if (this.chain) {
        const s = this.sketch;
        const before = this.chain.before;
        this.chain = null;
        void this.solveAndCommit(s, before);
        return true;
      }
      if (this.clicks.length || this.dimPicks.length) {
        this.clicks = [];
        this.dimPicks = [];
        return this.emitTrue();
      }
      if (this.tool !== 'select') {
        this.setTool('select');
        return true;
      }
      this.close();
      return true;
    }
    if (k === 'Enter') {
      if (this.tool === 'spline') this.finishSpline();
      else if (this.chain) return this.key('Escape');
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && this.selection.length) {
      this.deleteSelection();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ drawing

  draw(g: CanvasRenderingContext2D, toScreen: (x: number, y: number) => { x: number; y: number }, pal: Palette) {
    if (!this.editing) return;
    const s = this.sketch;
    const scr = (p: Vec2) => {
      const w = this.toWorld(p);
      return toScreen(w.x, w.y);
    };
    const over = overIds(s, [...(this.status?.conflicting ?? []), ...(this.status?.redundant ?? [])]);
    const colourFor = (id: string, kind: 'entity' | 'point', construction: boolean) => {
      if (this.selection.includes(id)) return pal.pick;
      if (construction) return pal.construction;
      const c = colourOf(id, kind, this.analysis, over);
      return c === 'over' ? pal.over : c === 'fully' ? pal.fully : pal.under;
    };
    const stroke = (pts: { x: number; y: number }[], colour: string, opts: { dash?: boolean; width?: number; closed?: boolean } = {}) => {
      if (pts.length < 2) return;
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      if (opts.closed) g.closePath();
      // A halo first, so the sketch reads over any field colour.
      g.setLineDash([]);
      g.strokeStyle = pal.halo;
      g.lineWidth = (opts.width ?? 1.75) + 3;
      g.stroke();
      g.setLineDash(opts.dash ? [6, 4] : []);
      g.strokeStyle = colour;
      g.lineWidth = opts.width ?? 1.75;
      g.stroke();
      g.setLineDash([]);
    };
    const curve = (e: SketchEntity): Vec2[] => {
      switch (e.kind) {
        case 'line':
          return [s.points[e.p[0]], s.points[e.p[1]]];
        case 'circle': {
          const c = s.points[e.c];
          return Array.from({ length: 97 }, (_, i) => [c[0] + e.r * Math.cos((i / 96) * 2 * Math.PI), c[1] + e.r * Math.sin((i / 96) * 2 * Math.PI)] as Vec2);
        }
        case 'arc': {
          const ag = arcGeom(s, e);
          if (!ag) return [];
          return Array.from({ length: 49 }, (_, i) => [ag.c[0] + ag.r * Math.cos(ag.a0 + (ag.sweep * i) / 48), ag.c[1] + ag.r * Math.sin(ag.a0 + (ag.sweep * i) / 48)] as Vec2);
        }
        case 'spline':
          return splineSamples(s, e, 96);
        default:
          return [];
      }
    };
    // The origin, on a halo where the marks need one.
    const markHalo = pal.markHalo && pal.markHalo !== 'transparent' ? pal.markHalo : null;
    const o = scr([0, 0]);
    const origin = () => {
      g.beginPath();
      g.moveTo(o.x - 8, o.y);
      g.lineTo(o.x + 8, o.y);
      g.moveTo(o.x, o.y - 8);
      g.lineTo(o.x, o.y + 8);
    };
    if (markHalo) {
      g.strokeStyle = markHalo;
      g.lineWidth = 4;
      origin();
      g.stroke();
    }
    g.strokeStyle = pal.construction;
    g.lineWidth = 1;
    origin();
    g.stroke();
    // Curves.
    for (const e of s.entities) {
      if (e.kind === 'point') continue;
      const construction = !!e.construction || (e.kind === 'line' && !!e.centerline);
      const pts = curve(e).map(scr);
      const hot = this.hover === e.id || this.dimPicks.includes(e.id);
      stroke(pts, hot ? pal.preview : colourFor(e.id, 'entity', construction), { dash: construction, width: hot ? 2.5 : 1.75 });
    }
    // Points.
    for (const [id, p] of Object.entries(s.points)) {
      const q = scr(p);
      const sel = this.selection.includes(id) || this.dimPicks.includes(id);
      g.beginPath();
      g.arc(q.x, q.y, sel || this.hover === id ? 4.5 : 3, 0, 2 * Math.PI);
      g.fillStyle = sel ? pal.pick : colourFor(id, 'point', false);
      g.strokeStyle = pal.halo;
      g.lineWidth = 1.5;
      g.fill();
      g.stroke();
    }
    // Where the outline is open or branches (on a halo where the marks need one).
    const prof = profileOf(s);
    for (const p of [...prof.open, ...prof.branch]) {
      const q = scr(p);
      g.beginPath();
      g.arc(q.x, q.y, 8, 0, 2 * Math.PI);
      if (markHalo) {
        g.strokeStyle = markHalo;
        g.lineWidth = 5;
        g.stroke();
      }
      g.strokeStyle = pal.over;
      g.lineWidth = 2;
      g.stroke();
    }
    // Dimensions.
    const mmpx = this.mmPerPx();
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const c of s.constraints) {
      if (!isDimension(c)) continue;
      const lay = layoutDimension(s, c, mmpx);
      if (!lay) continue;
      const colour = this.selection.includes(c.id) ? pal.pick : c.driving ? pal.fully : pal.construction;
      for (const [a, b] of lay.lines) stroke([scr(a), scr(b)], colour, { width: 1 });
      for (const ar of lay.arrows) {
        const tip = scr(ar.at);
        const back = scr([ar.at[0] - ar.dir[0] * 8 * mmpx, ar.at[1] - ar.dir[1] * 8 * mmpx]);
        const dx = tip.x - back.x;
        const dy = tip.y - back.y;
        g.beginPath();
        g.moveTo(tip.x, tip.y);
        g.lineTo(back.x - dy * 0.35, back.y + dx * 0.35);
        g.lineTo(back.x + dy * 0.35, back.y - dx * 0.35);
        g.closePath();
        g.fillStyle = colour;
        g.fill();
      }
      if (this.editingDim?.id === c.id) continue;
      const t = scr(lay.text);
      const v = measureDimension(s, c);
      const label = dimText(c, v);
      const w = g.measureText(label).width + 10;
      g.fillStyle = pal.halo;
      g.fillRect(t.x - w / 2, t.y - 9, w, 18);
      g.strokeStyle = colour;
      g.lineWidth = 1;
      g.strokeRect(t.x - w / 2, t.y - 9, w, 18);
      g.fillStyle = colour;
      g.fillText(label, t.x, t.y);
    }
    // Relation glyphs: one badge per relation, by the middle of its first curve or its point.
    const badges = new Map<string, number>();
    for (const c of s.constraints) {
      if (isDimension(c) || c.refs.includes('origin') && c.kind === 'coincident') continue;
      const icon = GLYPH_ICON[c.kind];
      const anchor = this.anchorOf(c);
      if (!icon || !anchor) continue;
      const key = `${Math.round(anchor[0] * 1000)}:${Math.round(anchor[1] * 1000)}`;
      const n = badges.get(key) ?? 0;
      badges.set(key, n + 1);
      const q = scr(anchor);
      const x = q.x + 10 + n * 16;
      const y = q.y - 16;
      g.fillStyle = pal.halo;
      g.fillRect(x - 1, y - 1, 15, 15);
      g.strokeStyle = this.status?.conflicting.includes(c.id) ? pal.over : pal.construction;
      g.lineWidth = 1;
      g.strokeRect(x - 1, y - 1, 15, 15);
      g.save();
      g.translate(x + 0.5, y + 0.5);
      g.scale(12 / 24, 12 / 24);
      g.strokeStyle = this.selection.includes(c.id) ? pal.pick : pal.fully;
      g.lineWidth = 2.5;
      g.stroke(new Path2D(icon));
      g.restore();
    }
    // What is being drawn.
    const cur = this.cursor;
    if (cur) {
      if (this.chain) stroke([scr(s.points[this.chain.from]), scr(cur)], pal.preview);
      const c0 = this.clicks[0]?.p;
      if (c0 && this.tool === 'rectangle') stroke([scr(c0), scr([cur[0], c0[1]]), scr(cur), scr([c0[0], cur[1]])], pal.preview, { closed: true });
      if (c0 && this.tool === 'circle') {
        const r = Math.hypot(cur[0] - c0[0], cur[1] - c0[1]);
        stroke(Array.from({ length: 65 }, (_, i) => scr([c0[0] + r * Math.cos((i / 64) * 2 * Math.PI), c0[1] + r * Math.sin((i / 64) * 2 * Math.PI)])), pal.preview);
      }
      if (this.tool === 'arc' || this.tool === 'spline') stroke([...this.clicks.map((k) => scr(k.p)), scr(cur)], pal.preview, { dash: this.tool === 'arc' });
      if (this.cursorSnap) {
        const q = scr(cur);
        g.beginPath();
        g.arc(q.x, q.y, 6, 0, 2 * Math.PI);
        if (markHalo) {
          g.strokeStyle = markHalo;
          g.lineWidth = 4.5;
          g.stroke();
        }
        g.strokeStyle = pal.preview;
        g.lineWidth = 1.5;
        g.stroke();
      }
    }
  }

  /** Where a relation's glyph goes: its first point, or the middle of its first curve. */
  private anchorOf(c: SketchConstraint): Vec2 | null {
    const s = this.sketch;
    const r = c.refs.find((x) => x !== 'origin');
    if (!r) return null;
    if (r in s.points) return s.points[r];
    const e = s.entities.find((x) => x.id === r);
    if (!e) return null;
    if (e.kind === 'line') return [(s.points[e.p[0]][0] + s.points[e.p[1]][0]) / 2, (s.points[e.p[0]][1] + s.points[e.p[1]][1]) / 2];
    if (e.kind === 'circle') return [s.points[e.c][0] + e.r * Math.SQRT1_2, s.points[e.c][1] + e.r * Math.SQRT1_2];
    if (e.kind === 'arc') {
      const ag = arcGeom(s, e);
      return ag ? [ag.c[0] + ag.r * Math.cos(ag.a0 + ag.sweep / 2), ag.c[1] + ag.r * Math.sin(ag.a0 + ag.sweep / 2)] : null;
    }
    const pid = pointIdOf(s, r);
    return pid ? s.points[pid] : null;
  }
}

/** A dimension's words: "40 mm", "R10 mm", "⌀20 mm", "30°", driven in parentheses. */
export function dimText(c: SketchDimension, v: number | null): string {
  const n = v == null ? '?' : formatDimNumber(v);
  const body = c.kind === 'angle' ? `${n}°` : `${c.kind === 'radius' ? 'R' : c.kind === 'diameter' ? '⌀' : ''}${n} mm`;
  return c.driving ? body : `(${body})`;
}
