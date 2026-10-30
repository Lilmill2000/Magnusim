// While the person's Move/copy body panel is open: its handle in the view (layer move_body.handle,
// order 50), Fusion's Move manipulator. At the pivot after the move (handle-math.ts): an arrow
// along X, Y and Z (red, green, blue: the triad's colours in the view's palette) and a ring about
// each; about a picked axis, one ring about that axis (the palette's blue). Each part has a thin
// rim in the view's background colour, so it reads over a body of its own colour (the Z arrow
// over a selected body's blue). A ring seen almost edge on is not drawn (its angle cannot be
// read). Hovered or held, a part is drawn thicker in its own colour (its rim takes the colour; the
// pick green would read as the Y axis).
//   Drag an arrow   Move X, Y or Z; drag a ring: the Angle (about that axis: About follows).
//                   Rounded to what a pixel means at that zoom; Ctrl held snaps to 1 mm and 15 deg.
//                   The panel's fields show each value as it changes, a label beside the handle
//                   says it ("X 12.5 mm", "Z 30°"), and the bodies are drawn there by the view's
//                   previewMotion: no rebuild, no kernel call, no save while the button is held.
//   Let go          the fields go to the panel as typed values do (one rebuild; Done keeps the
//                   feature, one undo step). The bodies stay drawn where they were dragged until
//                   the rebuild that puts them there is drawn.
//   Escape          while the button is held: the drag is put back (fields, bodies, handle) and
//                   the panel stays open, as Escape does in a field and on the Enclosure's arrows;
//                   the rest of that press is the handle's.
// A press on the handle never orbits, pans or selects. Pictures leave the layer out (snapshot.ts).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, TorusGeometry, Vector3, type Object3D } from 'three';
import type { AppServices } from '../../types/app';
import type { BodyId, MoveBodyFeature, Vec3 } from '../../types/doc';
import type { EditSession, MoveBodyOutput } from '../../types/doc-service';
import type { OverlayLayer, ViewportHandle, ViewportTool } from '../../types/viewport';
import { uiFor } from '../../ui/controller';
import { formatQuantity } from '../../ui/kit/format';
import { setFaceInk } from '../../viewport/onface';
import { LIGHT, paletteOf, type MarkPalette } from '../../viewport/palette';
import { axisParamAt } from '../extrude/handle';
import type { Mat } from '../pattern/transforms';
import {
  AXES,
  basisOf,
  draggedFields,
  EDGE_ON,
  handleFrameOf,
  isIdentity,
  previewMatrix,
  ringPhase,
  sameMatrix,
  shownOf,
  targetMatrix,
  turnLine,
  worldAxis,
  wrapPi,
  type DragAmount,
  type HandleFrame,
  type HandlePart,
  type Line,
  type Shown,
} from './handle-math';
import type { MoveValues } from './feature';

export const MOVE_HANDLE_LAYER = 'move_body.handle';
export const MOVE_HANDLE_TOOL = 'move_body.handle';
/** Sizes in CSS px: an arrow's shaft and head (as the Enclosure's), a ring's radius and tube; how near a press takes a part. */
const SHAFT_PX = 52;
const SHAFT_R_PX = 1.8;
const HEAD_PX = 16;
const HEAD_R_PX = 6.5;
export const RING_PX = 40;
const RING_TUBE_PX = 1.7;
const RING_STEPS = 72;
/** The rim round each part (CSS px). */
const RIM_PX = 1.6;
const GRAB_PX = 10;
/** One pixel round a ring, in degrees. */
const DEG_PER_PX = 180 / Math.PI / RING_PX;
/** After a release, the bodies stay where they were dragged at most this long while the rebuild draws them (ms). */
const SETTLE_MS = 8000;

const ARROWS = AXES;
const RINGS: HandlePart[] = ['ring-x', 'ring-y', 'ring-z', 'ring-axis'];
const isArrow = (p: HandlePart): p is 'x' | 'y' | 'z' => p === 'x' || p === 'y' || p === 'z';

/** A part's colour: X, Y, Z as the triad's (red, green, blue), a picked axis's ring the palette's blue. */
export function inkOf(part: HandlePart, p: MarkPalette): { color: number; face: number | null } {
  const k = part === 'x' || part === 'ring-x' ? 0 : part === 'y' || part === 'ring-y' ? 1 : part === 'z' || part === 'ring-z' ? 2 : null;
  if (k === null) return { color: p.ink, face: p.face ? p.face.ink : null };
  // Over a light face in a dark view: LIGHT's axis colour (E2, src/viewport/onface.ts).
  return { color: p.triad[k], face: p.face ? LIGHT.triad[k] : null };
}

export interface MoveHandleOptions {
  session: EditSession;
  /** The picked axis as the panel finds it while no build has found it (about a picked axis), or null. */
  liveAxis(): Line | null;
  /** The drag's fields while it runs (the panel shows them); null: the draft's again. */
  live(patch: Partial<MoveBodyFeature> | null): void;
  /** The drag's end: its fields, applied as typed values are; the refusal's words, or null. */
  commit(patch: Partial<MoveBodyFeature>): string | null;
}

/** What tests read of the handle (window.__CAD__.moveHandle): its parts in model terms, JSON-safe. */
export interface MoveHandleTestView {
  origin: Vec3;
  /** Model mm of one CSS pixel at the handle. */
  pixelMm: number;
  dragging: boolean;
  /**
   * Each part drawn now: its colour (0xrrggbb), whether it is lit (hovered or held: drawn
   * thicker), an arrow's direction (it starts at `origin`), a ring's axis, radius (mm) and u, v (a
   * turn by +a takes u towards v).
   */
  parts: { part: HandlePart; color: number; lit: boolean; dir?: Vec3; axis?: Vec3; radiusMm?: number; u?: Vec3; v?: Vec3 }[];
}

let current: (() => MoveHandleTestView | null) | null = null;
/** The open handle as tests read it, or null. */
export function moveHandleTest(): MoveHandleTestView | null {
  return current?.() ?? null;
}

class HandleView {
  private readonly mats = new Map<HandlePart, MeshBasicMaterial>();
  /** Each part's rim: the background colour, or its own while it is lit. */
  private readonly rims = new Map<HandlePart, MeshBasicMaterial>();
  private readonly items = new Map<HandlePart, Object3D>();
  private palette: MarkPalette;
  readonly label: HTMLElement;
  private lit: HandlePart | null = null;
  /** The parts drawn now and where (the last place()). */
  origin: Vec3 = [0, 0, 0];
  pixelMm = 1;
  rings = new Map<HandlePart, Vec3>();
  shown = new Set<HandlePart>();

  constructor(
    private readonly layer: OverlayLayer,
    palette: MarkPalette,
  ) {
    this.palette = palette;
    for (const part of [...ARROWS, ...RINGS] as HandlePart[]) {
      const mat = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
      const rim = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
      this.mats.set(part, mat);
      this.rims.set(part, rim);
      const o = new Group();
      // The rims draw first (order 9), under every part (order 10).
      const add = (m: Mesh, order: number, y = 0) => {
        m.position.y = y;
        m.renderOrder = order;
        m.frustumCulled = false;
        if (order === 9) m.userData.rim = true;
        o.add(m);
      };
      if (isArrow(part)) {
        add(new Mesh(new CylinderGeometry(SHAFT_R_PX + RIM_PX, SHAFT_R_PX + RIM_PX, SHAFT_PX, 10), rim), 9, SHAFT_PX / 2);
        add(new Mesh(new ConeGeometry(HEAD_R_PX + RIM_PX, HEAD_PX + 2 * RIM_PX, 18), rim), 9, SHAFT_PX + HEAD_PX / 2);
        add(new Mesh(new CylinderGeometry(SHAFT_R_PX, SHAFT_R_PX, SHAFT_PX, 10), mat), 10, SHAFT_PX / 2);
        add(new Mesh(new ConeGeometry(HEAD_R_PX, HEAD_PX, 18), mat), 10, SHAFT_PX + HEAD_PX / 2);
      } else {
        add(new Mesh(new TorusGeometry(RING_PX, RING_TUBE_PX + RIM_PX, 6, RING_STEPS), rim), 9);
        add(new Mesh(new TorusGeometry(RING_PX, RING_TUBE_PX, 6, RING_STEPS), mat), 10);
      }
      o.name = `move-handle:${part}`;
      o.userData.part = part;
      o.visible = false;
      layer.group.add(o);
      this.items.set(part, o);
    }
    this.setPalette(palette);
    this.label = document.createElement('span');
    this.label.className = 'cad-extrude-value cad-move-value';
    this.label.dataset.moveValue = '1';
    this.label.style.display = 'none';
    layer.html.appendChild(this.label);
  }

  setPalette(p: MarkPalette) {
    this.palette = p;
    for (const [part, mat] of this.mats) {
      const ink = inkOf(part, p);
      mat.color.setHex(ink.color);
      setFaceInk(mat, ink.face);
      this.paintRim(part);
    }
    this.layer.changed();
  }

  /** A part's rim: the background (it sets the part off whatever is behind it), or the part's own colour while lit. */
  private paintRim(part: HandlePart) {
    const rim = this.rims.get(part)!;
    if (part === this.lit) {
      const ink = inkOf(part, this.palette);
      rim.color.setHex(ink.color);
      setFaceInk(rim, ink.face);
    } else {
      rim.color.setHex(this.palette.background);
      setFaceInk(rim, null);
    }
  }

  /** The colour a part is drawn in now. */
  colorOf(part: HandlePart): number {
    return this.mats.get(part)!.color.getHex();
  }

  isLit(part: HandlePart): boolean {
    return part === this.lit;
  }

  highlight(part: HandlePart | null) {
    if (part === this.lit) return;
    const was = this.lit;
    this.lit = part;
    if (was) this.paintRim(was);
    if (part) this.paintRim(part);
    this.layer.changed();
  }

  /**
   * Put the parts at `origin`; `rings` the rings to draw; `view` the direction the camera looks at
   * the handle along. Called after each drawn frame too (the zoom sizes the parts): it asks for no
   * frame itself; `changed` does.
   */
  place(handle: ViewportHandle, origin: Vec3, rings: HandleFrame['rings'], view: Vec3 | null, changed: boolean) {
    const px = handle.pixelSize(origin);
    this.origin = origin;
    this.pixelMm = px;
    this.rings = new Map(rings.map((r) => [r.part, r.axis]));
    this.shown = new Set();
    const up = new Vector3(0, 1, 0);
    const z = new Vector3(0, 0, 1);
    for (const [part, o] of this.items) {
      let dir: Vec3 | undefined;
      if (isArrow(part)) dir = worldAxis(part);
      else dir = this.rings.get(part);
      const edgeOn = !isArrow(part) && !!dir && !!view && Math.abs(view[0] * dir[0] + view[1] * dir[1] + view[2] * dir[2]) < EDGE_ON;
      o.visible = !!dir && !edgeOn;
      if (!o.visible || !dir) continue;
      this.shown.add(part);
      o.position.set(...origin);
      o.quaternion.copy(new Quaternion().setFromUnitVectors(isArrow(part) ? up : z, new Vector3(...dir).normalize()));
      o.scale.setScalar(px);
    }
    if (changed) this.layer.changed();
  }

  hide() {
    for (const o of this.items.values()) o.visible = false;
    this.shown = new Set();
    this.layer.changed();
  }

  /** The part within grabbing distance of frame client coordinates (the nearest; an arrow before a ring at the same distance), or null. */
  at(handle: ViewportHandle, x: number, y: number): HandlePart | null {
    let best: { p: HandlePart; d: number } | null = null;
    const near = (p: HandlePart, d: number) => {
      if (d <= GRAB_PX && (!best || d < best.d - 1e-9)) best = { p, d };
    };
    const o = this.origin;
    const px = this.pixelMm;
    const seg = (a: [number, number], b: [number, number]) => {
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const l2 = vx * vx + vy * vy;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2));
      return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy));
    };
    for (const part of ARROWS) {
      if (!this.shown.has(part)) continue;
      const d = worldAxis(part);
      const len = (SHAFT_PX + HEAD_PX) * px;
      const p0 = handle.project(o);
      const p1 = handle.project([o[0] + d[0] * len, o[1] + d[1] * len, o[2] + d[2] * len]);
      if (p0 && p1) near(part, seg(p0, p1));
    }
    for (const part of RINGS) {
      const axis = this.rings.get(part);
      if (!axis || !this.shown.has(part)) continue;
      const { u, v } = basisOf(axis);
      const r = RING_PX * px;
      let prev: [number, number] | null = null;
      let d = Infinity;
      for (let i = 0; i <= RING_STEPS; i++) {
        const t = (2 * Math.PI * i) / RING_STEPS;
        const q = handle.project([o[0] + r * (Math.cos(t) * u[0] + Math.sin(t) * v[0]), o[1] + r * (Math.cos(t) * u[1] + Math.sin(t) * v[1]), o[2] + r * (Math.cos(t) * u[2] + Math.sin(t) * v[2])]);
        if (q && prev) d = Math.min(d, seg(prev, q));
        prev = q;
      }
      near(part, d);
    }
    return (best as { p: HandlePart; d: number } | null)?.p ?? null;
  }

  dispose() {
    for (const o of this.items.values()) {
      this.layer.group.remove(o);
      o.traverse((c) => {
        if ((c as Mesh).isMesh) (c as Mesh).geometry.dispose();
      });
    }
    for (const m of [...this.mats.values(), ...this.rims.values()]) m.dispose();
    this.label.remove();
  }
}

interface Drag {
  part: HandlePart;
  f0: MoveBodyFeature;
  v0: MoveValues;
  frame: HandleFrame;
  /** The handle's place when it was taken. */
  origin0: Vec3;
  /** The arrow's direction or the ring's axis. */
  axis: Vec3;
  /** An arrow: the axis parameter it was taken at. A ring: the angle round it it was taken at (rad). */
  grab: number;
  /** A ring: the last angle read, and how far it has turned (rad). */
  phase: number;
  turned: number;
  pixelMm: number;
  /** The fields and values it has set so far (null: none yet). */
  last: ReturnType<typeof draggedFields> | null;
}

/** Start the handle of an open Move/copy body panel. Returns stop; `refresh` re-places it (the panel calls it after each render). */
export function startMoveHandle(services: AppServices, handle: ViewportHandle, opts: MoveHandleOptions): { stop(): void; refresh(): void; dragging(): boolean } {
  const layer = handle.addLayer(MOVE_HANDLE_LAYER, { order: 50, palette: (p) => view.setPalette(p) });
  const view = new HandleView(layer, paletteOf(handle));
  const ui = uiFor(services);
  const draft = () => opts.session.draft as MoveBodyFeature;
  let drag: Drag | null = null;
  let swallowClick = false;
  let held = false;
  let stopped = false;
  /** The bodies drawn moved now, and how. */
  let previewed: { ids: BodyId[]; matrix: Mat } | null = null;
  /** A released drag waiting for its rebuild to be drawn. */
  let settling: { target: Mat; seq0: number; started: boolean; until: number } | null = null;
  /** What the view shows of the feature (kept while a rebuild runs: the bodies drawn are the last one's). */
  let lastShown: Shown | null = null;
  const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
  let cursorSet = '';
  const cursor = (c: '' | 'grab' | 'grabbing') => {
    if (!canvas || c === cursorSet) return;
    cursorSet = c;
    canvas.style.cursor = c;
  };

  const output = (): MoveBodyOutput | null => {
    const o = services.doc.state.get().rebuild.outputs[opts.session.feature];
    return o?.type === 'move_body' ? o : null;
  };
  const frameNow = (): HandleFrame | null => handleFrameOf(draft(), output(), services.doc.state.get().rebuild.bodies, services.doc.units, opts.liveAxis());
  const shownNow = (): Shown => {
    const s = services.doc.state.get();
    if (s.rebuild.status !== 'running' || !lastShown) lastShown = shownOf(s, draft());
    return lastShown;
  };
  const viewDir = (at: Vec3): Vec3 | null => {
    const p = handle.project(at);
    return p ? handle.rayAt(p[0], p[1]).dir : null;
  };

  const showPreview = (ids: BodyId[], m: Mat | null) => {
    const old = previewed;
    const moved = m && !isIdentity(m) ? m : null;
    if (old) {
      const gone = old.ids.filter((id) => !moved || !ids.includes(id));
      if (gone.length) handle.previewMotion?.(gone, null);
    }
    if (moved && ids.length) {
      if (!old || !sameMatrix(old.matrix, moved, 0) || old.ids.join() !== ids.join()) handle.previewMotion?.(ids, moved);
      previewed = { ids: [...ids], matrix: moved };
    } else previewed = null;
  };
  const clearPreview = () => showPreview([], null);

  /** Re-place the handle; `changed` (not after a frame): ask for a frame. */
  const place = (changed = true) => {
    if (stopped) return;
    const f = drag ? null : frameNow();
    if (drag) {
      const v = drag.last?.values ?? drag.v0;
      const o: Vec3 = [drag.frame.pivot[0] + v.move[0], drag.frame.pivot[1] + v.move[1], drag.frame.pivot[2] + v.move[2]];
      view.place(handle, o, drag.frame.rings, viewDir(o), changed);
    } else if (f) view.place(handle, f.origin, f.rings, viewDir(f.origin), changed);
    else if (view.shown.size) view.hide();
  };

  const showValue = (part: HandlePart, r: ReturnType<typeof draggedFields>, at: Vec3) => {
    const p = handle.project(at);
    if (!p) return;
    const box = layer.html.getBoundingClientRect();
    const name = isArrow(part) ? part.toUpperCase() : r.about === 'axis' ? 'Angle' : r.about.toUpperCase();
    view.label.textContent = `${name} ${formatQuantity(r.shown.value, r.shown.quantity, services.doc.state.get().doc.units).replace(/^-/, '−')}`;
    view.label.style.display = '';
    view.label.style.transform = `translate(${(p[0] - box.left + 16).toFixed(1)}px, ${(p[1] - box.top - 26).toFixed(1)}px)`;
  };

  /** The fields and the preview for the pointer at `ray`; null when the ray says nothing new (along the arrow, a ring edge on). */
  const follow = (d: Drag, ray: { origin: Vec3; dir: Vec3 }, snap: boolean): ReturnType<typeof draggedFields> | null => {
    let amount: DragAmount;
    if (isArrow(d.part)) {
      const at = axisParamAt(d.origin0, d.axis, ray);
      if (at == null) return null;
      amount = { part: d.part, mm: at - d.grab };
    } else {
      const ph = ringPhase(d.origin0, d.axis, ray);
      if (ph == null) return null;
      d.turned += wrapPi(ph - d.phase);
      d.phase = ph;
      amount = { part: d.part as Exclude<HandlePart, 'x' | 'y' | 'z'>, deg: (d.turned * 180) / Math.PI };
    }
    return draggedFields(d.f0, d.v0, amount, { pixelMm: d.pixelMm, degPerPx: DEG_PER_PX, units: services.doc.state.get().doc.units, snap });
  };

  const targetOf = (d: Drag, r: ReturnType<typeof draggedFields>): Mat => targetMatrix(r.values, turnLine(r.about, d.frame.pivot, d.frame.turnAxis));

  const sameFields = (a: Partial<MoveBodyFeature>, f: MoveBodyFeature) =>
    Object.entries(a).every(([k, v]) => JSON.stringify(v) === JSON.stringify((f as unknown as Record<string, unknown>)[k]));

  /** Put the drag back: the fields, the bodies and the handle as before it. */
  const putBack = () => {
    drag = null;
    view.label.style.display = 'none';
    view.highlight(null);
    cursor('');
    clearPreview();
    opts.live(null);
    place();
  };

  const settle = () => {
    if (!settling || stopped) return;
    const s = services.doc.state.get();
    const sh = shownNow();
    if (s.rebuild.status === 'running') {
      settling.started = true;
      showPreview(sh.bodies, previewMatrix(settling.target, sh.matrix));
      return;
    }
    if (sameMatrix(sh.matrix, settling.target) || settling.started || s.rebuild.seq > settling.seq0 || Date.now() > settling.until || !opts.session.open) {
      settling = null;
      clearPreview();
      place();
      return;
    }
    showPreview(sh.bodies, previewMatrix(settling.target, sh.matrix));
  };
  const offDoc = services.doc.state.subscribe(() => {
    if (!drag) settle();
    if (!drag) place();
  });
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const release = (d: Drag, r: ReturnType<typeof draggedFields> | null) => {
    drag = null;
    view.label.style.display = 'none';
    view.highlight(null);
    if (!r || sameFields(r.patch, d.f0)) {
      clearPreview();
      opts.live(null);
      place();
      return;
    }
    const seq0 = services.doc.state.get().rebuild.seq;
    const why = opts.commit(r.patch);
    opts.live(null);
    if (why || opts.session.incomplete() !== null) {
      // Refused, or not a whole feature yet ("Nothing to move"): the view shows what is built.
      clearPreview();
      place();
      return;
    }
    settling = { target: targetOf(d, r), seq0, started: services.doc.state.get().rebuild.status === 'running', until: Date.now() + SETTLE_MS };
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settle();
    }, SETTLE_MS + 50);
    settle();
    place();
  };

  // Escape while the button is held puts the drag back and keeps the panel open (the Enclosure's arrows do the same).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    held = true;
    putBack();
  };
  window.addEventListener('keydown', onKey, true);

  const tool: ViewportTool = {
    id: MOVE_HANDLE_TOOL,
    onPointer(e) {
      if (held) {
        if (e.type === 'up' || e.type === 'leave') {
          held = false;
          swallowClick = e.type === 'up';
        }
        return true;
      }
      if (services.mode.get().mode !== 'model') return false;
      if (drag) {
        const d = drag;
        if (e.type === 'move') {
          const r = follow(d, e.ray, e.ctrl);
          if (!r) return true;
          const changed = !d.last || JSON.stringify(r.patch) !== JSON.stringify(d.last.patch);
          d.last = r;
          const sh = shownNow();
          showPreview(sh.bodies, previewMatrix(targetOf(d, r), sh.matrix));
          place();
          showValue(d.part, r, view.origin);
          if (changed) opts.live(r.patch);
          return true;
        }
        if (e.type === 'up' || e.type === 'leave') {
          swallowClick = e.type === 'up';
          // Where it was let go: moves are drawn once a frame, so the last one may not have been seen.
          const r = e.type === 'up' ? (follow(d, e.ray, e.ctrl) ?? d.last) : d.last;
          cursor(e.type === 'up' && view.at(handle, e.clientX, e.clientY) ? 'grab' : '');
          release(d, r);
          return true;
        }
        return true;
      }
      if (e.type === 'down' && e.button === 0 && !e.alt) {
        const part = view.at(handle, e.clientX, e.clientY);
        if (!part) return false;
        // Taken: the press is the handle's even when nothing can move now (nothing orbits under it).
        const f = draft();
        const frame = frameNow();
        if (!frame?.values || ui.editBlock() || !opts.session.open) return true;
        if (settling) {
          settling = null;
          clearPreview();
        }
        const origin0 = frame.origin;
        const axis = isArrow(part) ? worldAxis(part) : (frame.rings.find((r) => r.part === part)?.axis ?? null);
        if (!axis) return true;
        const grab = isArrow(part) ? axisParamAt(origin0, axis, e.ray) : ringPhase(origin0, axis, e.ray);
        if (grab == null) return true;
        drag = { part, f0: f, v0: frame.values, frame, origin0, axis, grab: isArrow(part) ? grab : 0, phase: isArrow(part) ? 0 : grab, turned: 0, pixelMm: handle.pixelSize(origin0), last: null };
        view.highlight(part);
        cursor('grabbing');
        return true;
      }
      if (e.type === 'move' && !e.buttons) {
        const part = view.at(handle, e.clientX, e.clientY);
        view.highlight(part);
        cursor(part ? 'grab' : '');
        return !!part;
      }
      if (e.type === 'click' && swallowClick) {
        swallowClick = false;
        return true;
      }
      swallowClick = false;
      if (e.type === 'leave') {
        view.highlight(null);
        cursor('');
      }
      return false;
    },
  };
  const pop = handle.pushTool(tool);
  const offFrame = handle.onFrame(() => place(false));
  const testView = (): MoveHandleTestView => ({
    origin: [...view.origin] as Vec3,
    pixelMm: view.pixelMm,
    dragging: !!drag,
    parts: [...view.shown].map((part) => {
      const color = view.colorOf(part);
      const lit = view.isLit(part);
      if (isArrow(part)) return { part, color, lit, dir: worldAxis(part) };
      const axis = view.rings.get(part)!;
      const { u, v } = basisOf(axis);
      return { part, color, lit, axis: [...axis] as Vec3, radiusMm: RING_PX * view.pixelMm, u, v };
    }),
  });
  current = testView;
  place();
  return {
    refresh: () => {
      if (!drag) place();
    },
    dragging: () => !!drag,
    stop() {
      if (stopped) return;
      stopped = true;
      if (drag) opts.live(null);
      drag = null;
      settling = null;
      if (settleTimer) clearTimeout(settleTimer);
      clearPreview();
      window.removeEventListener('keydown', onKey, true);
      cursor('');
      pop();
      offFrame();
      offDoc();
      if (current === testView) current = null;
      view.dispose();
      layer.dispose();
    },
  };
}
