// The marks over the tunnel's view: the rakes, the probes, the selection and its turn handle,
// the pose a body is being dragged or turned to, outlines of what is not in the flow, and the
// sketch being edited. Drawn in CSS px on the view's overlay canvas every frame (Viewport.tsx),
// and drawn again in the light colours for each picture or recorded frame (src/app/capture.ts).
// SPDX-License-Identifier: GPL-3.0-or-later
import { overlaySet } from '../app/colours';
import { transformRings, type Rings } from '../geometry/polygon';
import { hasOutline, outlineRings, profileOf } from '../geometry/shapes';
import type { Engine } from '../sim/engine';
import type { Body, Rake, Scene } from '../scene/scene';
import type { Store } from '../app/store';
import type { Palette, SketchEditor } from '../sketch/editor';

const HANDLE_GAP_PX = 26;
export const HANDLE_R_PX = 7;
export const PROBE_R_PX = 5;

const outlines = new Map<string, Rings>();
function localOutline(b: Body): Rings {
  const key = JSON.stringify(b.shape);
  let p = outlines.get(key);
  if (!p) {
    p = outlineRings(b.shape);
    if (outlines.size > 64) outlines.clear();
    outlines.set(key, p);
  }
  return p;
}

/** A body's outline rings in the world at a pose. */
export function worldOutline(b: Body, pose: { x: number; y: number; angle: number }): Rings {
  return transformRings(localOutline(b), { x: pose.x, y: pose.y, theta: (-pose.angle * Math.PI) / 180 });
}

export type Drag =
  | { kind: 'probe'; id: string; before: Scene; moved: boolean }
  | { kind: 'rake'; id: string; part: 'all' | 'start' | 'end'; startX: number; startY: number; r0: Rake; before: Scene }
  | { kind: 'move'; id: string; startX: number; startY: number; bodyX: number; bodyY: number; angle: number; moved: boolean }
  | { kind: 'turn'; id: string; startAngle: number; pointerStart: number; angle: number; x: number; y: number }
  | { kind: 'pan'; startX: number; startY: number; cx: number; cy: number };

/** The turn handle of a body (CSS px from the view's top-left): above its outline, on the pivot's vertical. */
export function turnHandle(engine: Engine, b: Body): { x: number; y: number; cx: number; cy: number } {
  const v = engine.worldView;
  const toScreen = (x: number, y: number) => ({ x: v.w / 2 + (x - v.cx) / v.mpp, y: v.h / 2 - (y - v.cy) / v.mpp });
  const pose = engine.livePose(b.id) ?? { x: b.x, y: b.y, angle: b.angle };
  let top = toScreen(0, pose.y).y;
  for (const poly of worldOutline(b, pose)) for (let i = 1; i < poly.length; i += 2) top = Math.min(top, toScreen(0, poly[i]).y);
  const c = toScreen(pose.x, pose.y);
  return { x: c.x, y: top - HANDLE_GAP_PX, cx: c.x, cy: c.y };
}

/** The colours the marks are drawn in (src/app/colours.ts reads them from the tokens). */
export interface OverlayColours {
  /** The selection; the selected probe's name (blue as text). */
  sel: string;
  selInk: string;
  /** Outlines of what is not in the flow, or not there yet (dashed). */
  ghost: string;
  /** Under a probe or a handle, and round a probe's name. */
  halo: string;
  /** A probe's ring, cross and name. */
  probe: string;
  /** Each rake colour (an empty one draws in the selection's). */
  rakes: string[];
  /** The sketch being edited. */
  sketch: Palette;
}

/** What one frame of the overlay shows. */
export interface OverlayState {
  /** The view's size (CSS px) and its device pixel ratio. */
  view: { w: number; h: number; dpr: number };
  scene: Scene;
  selected: string | null;
  drag: Drag | null;
  editor?: SketchEditor;
  toScreen: (x: number, y: number) => { x: number; y: number };
  poseOf: (b: Body) => { x: number; y: number; angle: number };
  handleOf: (b: Body) => { x: number; y: number; cx: number; cy: number };
}

/** The overlay's state now: the engine's view and the poses the flow has, the store's scene and selection. */
export function overlayState(engine: Engine, store: Store, drag: Drag | null, editor?: SketchEditor): OverlayState {
  const { scene, selected } = store.get();
  return {
    view: engine.worldView,
    scene,
    selected,
    drag,
    editor,
    toScreen: (x, y) => {
      const v = engine.worldView;
      return { x: v.w / 2 + (x - v.cx) / v.mpp, y: v.h / 2 - (y - v.cy) / v.mpp };
    },
    poseOf: (b) => engine.livePose(b.id) ?? { x: b.x, y: b.y, angle: b.angle },
    handleOf: (b) => turnHandle(engine, b),
  };
}

/** One frame of the overlay: the canvas cleared, then the marks. */
export function paintOverlay(g: CanvasRenderingContext2D, st: OverlayState, c: OverlayColours) {
  const v = st.view;
  g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  g.clearRect(0, 0, v.w, v.h);
  drawOverlay(g, st, c);
}

/** The marks a picture or a recording draws over the flow: this frame's, in the light colours (kept files stay light). */
export function lightOverlay(state: () => OverlayState): (g: CanvasRenderingContext2D) => void {
  return (g) => paintOverlay(g, state(), overlaySet('light'));
}

/** The marks, in CSS px (the canvas's transform set to the device pixel ratio). */
export function drawOverlay(g: CanvasRenderingContext2D, st: OverlayState, c: OverlayColours) {
  const { scene, selected, toScreen, poseOf, handleOf, editor } = st;
  const { sel, ghost, halo: handleFill, probe: probeInk, sketch: pal } = c;
  const d = st.drag;
  for (const r of scene.rakes) {
    const color = c.rakes[r.color % 6] || sel;
    const a = toScreen(r.x0, r.y0);
    const b = toScreen(r.x1, r.y1);
    const isSel = r.id === selected;
    g.globalAlpha = r.enabled ? 1 : 0.45;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.strokeStyle = color;
    g.lineWidth = isSel ? 3 : 2;
    g.setLineDash(r.kind === 'timelines' ? [6, 4] : []);
    g.stroke();
    g.setLineDash([]);
    if (r.kind !== 'timelines') {
      g.fillStyle = color;
      for (let e = 0; e < r.emitters; e++) {
        const t = r.emitters === 1 ? 0.5 : e / (r.emitters - 1);
        g.beginPath();
        g.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (isSel) {
      for (const p of [a, b]) {
        g.fillStyle = handleFill;
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.fillRect(p.x - 5, p.y - 5, 10, 10);
        g.strokeRect(p.x - 5, p.y - 5, 10, 10);
      }
    }
    g.globalAlpha = 1;
  }
  // Probes: a ringed cross with its name.
  scene.probes.forEach((p, i) => {
    const s = toScreen(p.x, p.y);
    const isSel = p.id === selected;
    g.beginPath();
    g.arc(s.x, s.y, PROBE_R_PX, 0, Math.PI * 2);
    g.fillStyle = handleFill;
    g.fill();
    g.strokeStyle = isSel ? sel : probeInk;
    g.lineWidth = isSel ? 2.5 : 1.5;
    g.stroke();
    g.beginPath();
    g.moveTo(s.x - PROBE_R_PX - 3, s.y);
    g.lineTo(s.x + PROBE_R_PX + 3, s.y);
    g.moveTo(s.x, s.y - PROBE_R_PX - 3);
    g.lineTo(s.x, s.y + PROBE_R_PX + 3);
    g.stroke();
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.lineWidth = 3;
    g.strokeStyle = handleFill;
    g.strokeText(`P${i + 1}`, s.x + PROBE_R_PX + 2, s.y - PROBE_R_PX);
    g.fillStyle = isSel ? c.selInk : probeInk;
    g.fillText(`P${i + 1}`, s.x + PROBE_R_PX + 2, s.y - PROBE_R_PX);
  });
  const sketching = editor?.editing ? editor.bodyId : null;
  for (const b of scene.bodies) {
    // The sketch being edited draws itself (its own points and curves, no turn handle).
    const isSel = b.id === selected && b.id !== sketching;
    const target =
      d && (d.kind === 'move' || d.kind === 'turn') && d.id === b.id
        ? { x: d.kind === 'move' ? d.bodyX : d.x, y: d.kind === 'move' ? d.bodyY : d.y, angle: d.angle }
        : null;
    const pose = poseOf(b);
    const path = (rings: Rings) => {
      g.beginPath();
      for (const poly of rings) {
        for (let i = 0; i < poly.length; i += 2) {
          const s = toScreen(poly[i], poly[i + 1]);
          if (i === 0) g.moveTo(s.x, s.y);
          else g.lineTo(s.x, s.y);
        }
        g.closePath();
      }
    };
    if (b.shape.kind === 'sketch' && b.id !== sketching && !hasOutline(b.shape)) {
      // A sketch with no closed outline is not in the flow: its curves, faint, where it is.
      const th = (-pose.angle * Math.PI) / 180;
      const c = Math.cos(th);
      const s = Math.sin(th);
      g.beginPath();
      for (const poly of profileOf(b.shape.sketch).curves) {
        poly.forEach(([u, v], i) => {
          const p = toScreen(pose.x + (c * u - s * v) / 1000, pose.y + (s * u + c * v) / 1000);
          if (i === 0) g.moveTo(p.x, p.y);
          else g.lineTo(p.x, p.y);
        });
      }
      g.setLineDash([4, 4]);
      g.strokeStyle = isSel ? sel : ghost;
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);
    }
    if (!b.enabled) {
      path(worldOutline(b, pose));
      g.setLineDash([4, 4]);
      g.strokeStyle = ghost;
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);
    }
    if (target && (Math.abs(target.x - pose.x) > 1e-6 || Math.abs(target.y - pose.y) > 1e-6 || Math.abs(target.angle - pose.angle) > 1e-3)) {
      // Where the body is going; the flow's body catches up at the lattice's speed limit.
      path(worldOutline(b, target));
      g.setLineDash([5, 4]);
      g.strokeStyle = ghost;
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);
    }
    if (isSel) {
      path(worldOutline(b, pose));
      g.strokeStyle = sel;
      g.lineWidth = 2;
      g.stroke();
      if (!b.locked) {
        const h = handleOf(b);
        g.beginPath();
        g.moveTo(h.cx, h.cy);
        g.lineTo(h.x, h.y + HANDLE_R_PX);
        g.strokeStyle = sel;
        g.lineWidth = 1;
        g.stroke();
        g.beginPath();
        g.arc(h.x, h.y, HANDLE_R_PX, 0, Math.PI * 2);
        g.fillStyle = handleFill;
        g.fill();
        g.lineWidth = 2;
        g.stroke();
      }
      const c = toScreen(pose.x, pose.y);
      g.beginPath();
      g.moveTo(c.x - 5, c.y);
      g.lineTo(c.x + 5, c.y);
      g.moveTo(c.x, c.y - 5);
      g.lineTo(c.x, c.y + 5);
      g.lineWidth = 1.5;
      g.stroke();
    }
  }
  if (sketching) editor!.draw(g, toScreen, pal);
}
