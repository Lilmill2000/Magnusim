// While the Section view panel is open and the view is cut: an arrow on the cut along the plane's
// normal (layer section.arrow, order 50), drawn as Move/copy body's arrows are (a shaft and a head with
// a thin rim in the view's background colour, on top of everything) in the palette's ink, which
// follows what is under it (E2: LIGHT's ink over a light surface or a cap in a dark view).
//   Hover       the arrow is lit (its rim takes its colour) and the cursor is a hand.
//   Drag        the cut moves along the normal with the pointer (handle-math.ts: rounded to a pixel's
//               step, Ctrl to whole steps); the panel's Offset follows as the view's section state
//               changes, and a label beside the arrow says it ("Offset 12.5 mm"). Only the clipping
//               plane moves: no rebuild, no kernel call; the Part keeps the offset once it is let go.
//   Escape      while the button is held: the offset as it was before the drag (the rest of that
//               press is the arrow's).
// A press on the arrow never orbits, pans or selects. Pictures leave the layer out (snapshot.ts).
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { AppServices } from '../../types/app';
import type { Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle, ViewportTool } from '../../types/viewport';
import { formatQuantity } from '../../ui/kit/format';
import { setFaceInk } from '../../viewport/onface';
import { paletteOf, type MarkPalette } from '../../viewport/palette';
import { axisParamAt } from '../extrude/handle';
import { sectionNotes } from './bind';
import { arrowPlace, draggedOffset } from './handle-math';

export const SECTION_ARROW_LAYER = 'section.arrow';
export const SECTION_ARROW_TOOL = 'section.arrow';
/** Sizes in CSS px (as Move/copy body's arrows): the shaft and head, the rim, how near a press takes it. */
const SHAFT_PX = 52;
const SHAFT_R_PX = 1.8;
const HEAD_PX = 16;
const HEAD_R_PX = 6.5;
const RIM_PX = 1.6;
const GRAB_PX = 10;

/** What tests read of the arrow (window.__CAD__.sectionArrow): where it is, JSON-safe. */
export interface SectionArrowTestView {
  origin: Vec3;
  dir: Vec3;
  /** Model mm of one CSS pixel at the arrow. */
  pixelMm: number;
  /** Its length on screen in model mm (shaft and head). */
  lengthMm: number;
  color: number;
  lit: boolean;
  dragging: boolean;
}

let current: (() => SectionArrowTestView | null) | null = null;
/** The arrow as tests read it, or null when none is drawn. */
export function sectionArrowTest(): SectionArrowTestView | null {
  return current?.() ?? null;
}

interface Drag {
  offset0: number;
  origin0: Vec3;
  dir: Vec3;
  grab: number;
  pixelMm: number;
  last: number;
}

/** Start the arrow (the panel calls it while it is open). Returns stop. */
export function startSectionArrow(services: AppServices, handle: ViewportHandle): () => void {
  const layer: OverlayLayer = handle.addLayer(SECTION_ARROW_LAYER, { order: 50, palette: (p) => paint(p) });
  const notes = sectionNotes(services);
  const group = new Group();
  group.name = 'section-arrow';
  group.visible = false;
  const mat = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
  const rim = new MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
  const add = (m: Mesh, order: number, y: number) => {
    m.position.y = y;
    m.renderOrder = order;
    m.frustumCulled = false;
    group.add(m);
  };
  add(new Mesh(new CylinderGeometry(SHAFT_R_PX + RIM_PX, SHAFT_R_PX + RIM_PX, SHAFT_PX, 10), rim), 9, SHAFT_PX / 2);
  add(new Mesh(new ConeGeometry(HEAD_R_PX + RIM_PX, HEAD_PX + 2 * RIM_PX, 18), rim), 9, SHAFT_PX + HEAD_PX / 2);
  add(new Mesh(new CylinderGeometry(SHAFT_R_PX, SHAFT_R_PX, SHAFT_PX, 10), mat), 10, SHAFT_PX / 2);
  add(new Mesh(new ConeGeometry(HEAD_R_PX, HEAD_PX, 18), mat), 10, SHAFT_PX + HEAD_PX / 2);
  layer.group.add(group);
  const label = document.createElement('span');
  label.className = 'cad-extrude-value cad-move-value';
  label.dataset.sectionDragValue = '1';
  label.style.display = 'none';
  layer.html.appendChild(label);

  let palette: MarkPalette = paletteOf(handle);
  let lit = false;
  let drag: Drag | null = null;
  let held = false;
  let swallowClick = false;
  let stopped = false;
  let place: { origin: Vec3; dir: Vec3; pixelMm: number } | null = null;
  const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
  let cursorSet = '';
  const cursor = (c: '' | 'grab' | 'grabbing') => {
    if (!canvas || c === cursorSet) return;
    cursorSet = c;
    canvas.style.cursor = c;
  };

  function paint(p: MarkPalette) {
    palette = p;
    mat.color.setHex(p.ink);
    setFaceInk(mat, p.face ? p.face.ink : null);
    if (lit) {
      rim.color.setHex(p.ink);
      setFaceInk(rim, p.face ? p.face.ink : null);
    } else {
      rim.color.setHex(p.background);
      setFaceInk(rim, null);
    }
    layer.changed();
  }
  paint(palette);

  const light = (on: boolean) => {
    if (on === lit) return;
    lit = on;
    paint(palette);
  };

  /** Where the arrow goes now: on the cut, with the section on; else hidden. */
  const reposition = (changed = true) => {
    if (stopped) return;
    const sec = handle.state.get().section;
    if (!sec.on || services.mode.get().mode !== 'model') {
      place = null;
      if (group.visible) {
        group.visible = false;
        layer.changed();
      }
      return;
    }
    const boxes = services.doc.state.get().rebuild.bodies.filter((b) => b.visible).map((b) => b.bbox);
    const at = arrowPlace(sec.frame, sec.offset, boxes);
    const px = handle.pixelSize(at.origin);
    place = { ...at, pixelMm: px };
    group.visible = true;
    group.position.set(...at.origin);
    group.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...at.dir)));
    group.scale.setScalar(px);
    if (changed) layer.changed();
  };

  /** The arrow within grabbing distance of frame client coordinates. */
  const near = (x: number, y: number): boolean => {
    if (!place) return false;
    const len = (SHAFT_PX + HEAD_PX) * place.pixelMm;
    const a = handle.project(place.origin);
    const b = handle.project([place.origin[0] + place.dir[0] * len, place.origin[1] + place.dir[1] * len, place.origin[2] + place.dir[2] * len]);
    if (!a || !b) return false;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const l2 = vx * vx + vy * vy;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l2));
    return Math.hypot(x - (a[0] + t * vx), y - (a[1] + t * vy)) <= GRAB_PX;
  };

  const showValue = (offset: number) => {
    if (!place) return;
    const p = handle.project(place.origin);
    if (!p) return;
    const box = layer.html.getBoundingClientRect();
    label.textContent = `Offset ${formatQuantity(offset, 'length', services.doc.state.get().doc.units).replace(/^-/, '−')}`;
    label.style.display = '';
    label.style.transform = `translate(${(p[0] - box.left + 16).toFixed(1)}px, ${(p[1] - box.top - 26).toFixed(1)}px)`;
  };

  const end = (putBack: boolean) => {
    const d = drag;
    drag = null;
    label.style.display = 'none';
    light(false);
    cursor('');
    if (d && putBack) handle.setSection({ offset: d.offset0 });
    notes.set({ dragging: false });
    reposition();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    held = true;
    end(true);
  };
  window.addEventListener('keydown', onKey, true);

  const follow = (d: Drag, ray: { origin: Vec3; dir: Vec3 }, snap: boolean): number | null => {
    const t = axisParamAt(d.origin0, d.dir, ray);
    if (t == null) return null;
    return draggedOffset(d.offset0, t - d.grab, d.pixelMm, services.doc.state.get().doc.units, snap);
  };

  const tool: ViewportTool = {
    id: SECTION_ARROW_TOOL,
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
          const off = follow(d, e.ray, e.ctrl);
          if (off == null) return true;
          if (off !== d.last) {
            d.last = off;
            handle.setSection({ offset: off });
          }
          showValue(off);
          return true;
        }
        if (e.type === 'up' || e.type === 'leave') {
          swallowClick = e.type === 'up';
          // Where it was let go: moves are drawn once a frame, so the last one may not have been seen.
          const off = e.type === 'up' ? follow(d, e.ray, e.ctrl) : null;
          if (off != null && off !== d.last) handle.setSection({ offset: off });
          end(false);
          if (e.type === 'up' && near(e.clientX, e.clientY)) {
            light(true);
            cursor('grab');
          }
          return true;
        }
        return true;
      }
      if (e.type === 'down' && e.button === 0 && !e.alt) {
        if (!near(e.clientX, e.clientY) || !place) return false;
        const sec = handle.state.get().section;
        const grab = axisParamAt(place.origin, place.dir, e.ray);
        // Looking straight down the arrow: taken, but nothing to drag along.
        if (grab == null) return true;
        drag = { offset0: sec.offset, origin0: place.origin, dir: place.dir, grab, pixelMm: place.pixelMm, last: sec.offset };
        notes.set({ dragging: true });
        light(true);
        cursor('grabbing');
        return true;
      }
      if (e.type === 'move' && !e.buttons) {
        const on = near(e.clientX, e.clientY);
        light(on);
        cursor(on ? 'grab' : '');
        reposition();
        return on;
      }
      if (e.type === 'click' && swallowClick) {
        swallowClick = false;
        return true;
      }
      swallowClick = false;
      if (e.type === 'leave') {
        light(false);
        cursor('');
      }
      return false;
    },
  };
  const pop = handle.pushTool(tool);
  // The arrow goes with the cut (a drag, a typed offset, another plane) and sizes with the zoom.
  const offFrame = handle.onFrame(() => reposition(false));
  const offState = handle.state.subscribe((v, prev) => {
    if (v.section !== prev.section) reposition();
  });
  const offDoc = services.doc.state.subscribe((s, prev) => {
    if (s.rebuild.bodies !== prev.rebuild.bodies) reposition();
  });
  const offMode = services.mode.subscribe(() => reposition());
  const testView = (): SectionArrowTestView | null =>
    place && group.visible
      ? { origin: [...place.origin] as Vec3, dir: [...place.dir] as Vec3, pixelMm: place.pixelMm, lengthMm: (SHAFT_PX + HEAD_PX) * place.pixelMm, color: mat.color.getHex(), lit, dragging: !!drag }
      : null;
  current = testView;
  reposition();
  return () => {
    if (stopped) return;
    stopped = true;
    if (drag) end(true);
    window.removeEventListener('keydown', onKey, true);
    cursor('');
    pop();
    offFrame();
    offState();
    offDoc();
    offMode();
    if (current === testView) current = null;
    group.traverse((c) => {
      if ((c as Mesh).isMesh) (c as Mesh).geometry.dispose();
    });
    mat.dispose();
    rim.dispose();
    label.remove();
    layer.dispose();
  };
}
