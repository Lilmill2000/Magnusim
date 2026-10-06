// While an Extrude panel is open: its pointer tool and its distance handle.
//   - A click on a shaded region toggles it in the extrude's profiles (one
//     sketch: a region of another sketch is refused with the reason).
//   - P4a: with no profile picked, a click on a flat face of a body makes that
//     face the profile (extruded with no sketch; a new extrude turns to Join);
//     a click on it again takes it out.
//   - The arrow at the end of the extrude (layer extrude.handle, order 50)
//     drags the distance along the extrude direction (it keeps the offset to
//     the pointer it was taken at); the value shows beside it, rounded to what
//     a pixel means at that zoom; the body follows live
//     (the panel session applies it) and the drag's end stores the value.
//     Blind: one arrow; Symmetric: one arrow at half the length (drags the
//     whole length); Two sides: an arrow on each side.
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { AppServices } from '../../types/app';
import type { ExtrudeFeature, Vec2, Vec3 } from '../../types/doc';
import type { EditSession } from '../../types/doc-service';
import type { ExtrudeExtent } from '../../types/kernel-protocol';
import type { DocUnits } from '../../types/units';
import type { OverlayLayer, ViewportHandle, ViewportPointer, ViewportTool } from '../../types/viewport';
import { exprToStore, formatQuantity, MM_PER } from '../../ui/kit/format';
import { PICK_COLOR } from '../../viewport/colors';
import { toModel } from '../sketch/plane';
import { regionUnder } from '../sketch/pick';
import { profilesView, sketchOutput } from '../sketch/view';
import { resolveExtent, type ExtentValues } from './def';
import { entityParents, refOfRegion, resolveRegionRef } from './profiles';
import { pickFace } from '../p2/refs';

export const HANDLE_LAYER = 'extrude.handle';
export const PANEL_TOOL_ID = 'extrude.panel';
/** Arrow size in CSS px: shaft length and radius, head length and radius; grab distance (review P2/P3 round 2: 45 px was small). */
const SHAFT_PX = 58;
const SHAFT_R_PX = 1.8;
const HEAD_PX = 18;
const HEAD_R_PX = 7;
const GRAB_PX = 12;
/** Live drag updates at most this often (ms); the drag's end always applies. */
const DRAG_APPLY_MS = 90;

export interface Arrow {
  /** 'd1': the (only, or first) distance; 'd2': the second side of Two sides. */
  which: 'd1' | 'd2';
  /** Where the arrow starts (the end cap's middle on that side). */
  base: Vec3;
  /** Unit direction it points (out of the extrude). */
  dir: Vec3;
}

export interface HandleGeometry {
  /** The profile point the arrows' axis goes through (on the sketch plane). */
  origin: Vec3;
  /** The extrude direction (sketch normal, or opposite with flip). */
  axis: Vec3;
  extent: Extract<ExtrudeExtent, { kind: 'blind' | 'symmetric' | 'two' }>;
  arrows: Arrow[];
}

const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unitOf = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Where the arrows go for an extrude as drafted (null when it cannot be placed: no profile found, a bad distance). */
export function handleGeometry(f: ExtrudeFeature, services: AppServices): HandleGeometry | null {
  const s = services.doc.state.get();
  const ext = resolveExtent(f, services.doc.units);
  if (!ext.ok) return null;
  // Along a picked axis: no arrow (it would point along the normal).
  if (f.direction) return null;
  const e = ext.values;
  // Through all and Up to have no length to drag.
  if (e.kind !== 'blind' && e.kind !== 'symmetric' && e.kind !== 'two') return null;
  if (f.face) {
    // A flat face extruded directly: the arrows start at the face as it was picked (its centroid and outward normal).
    const n = f.face.ref.signature.dir;
    if (!n) return null;
    const out = unitOf(n as Vec3);
    return arrowsFor([...f.face.ref.signature.at] as Vec3, f.flip ? [-out[0], -out[1], -out[2]] : out, e);
  }
  if (!f.profiles?.length) return null;
  const out = sketchOutput(s, f.profiles[0].sketch);
  if (!out) return null;
  const sketch = s.doc.features.find((g) => g.id === f.profiles[0].sketch);
  const parents = entityParents(sketch && sketch.type === 'sketch' ? sketch.entities : []);
  let sample: Vec2 | null = null;
  for (const p of f.profiles) {
    const r = resolveRegionRef(p, out.regions, parents);
    if (r.ok) {
      sample = r.region.sample;
      break;
    }
  }
  if (!sample) return null;
  const origin = toModel(out.plane, sample);
  const axis = unitOf(f.flip ? [-out.plane.normal[0], -out.plane.normal[1], -out.plane.normal[2]] : out.plane.normal);
  return arrowsFor(origin, axis, e);
}

/** The arrows of a blind, symmetric or two-sided extent from `origin` along `axis`. */
function arrowsFor(origin: Vec3, axis: Vec3, e: Extract<ExtrudeExtent, { kind: 'blind' | 'symmetric' | 'two' }>): HandleGeometry {
  const arrows: Arrow[] = [];
  if (e.kind === 'blind') arrows.push({ which: 'd1', base: add(origin, axis, e.d), dir: e.d < 0 ? [-axis[0], -axis[1], -axis[2]] : axis });
  else if (e.kind === 'symmetric') arrows.push({ which: 'd1', base: add(origin, axis, e.d / 2), dir: axis });
  else if (e.kind === 'two') {
    arrows.push({ which: 'd1', base: add(origin, axis, e.d1), dir: axis });
    arrows.push({ which: 'd2', base: add(origin, axis, -e.d2), dir: [-axis[0], -axis[1], -axis[2]] });
  }
  return { origin, axis, extent: e, arrows };
}

/** The length a distance field holds (mm): blind and symmetric `d`, two sides `d1` / `d2`. */
export function extentLength(e: ExtrudeExtent | ExtentValues, which: 'd1' | 'd2'): number | null {
  if (e.kind === 'blind' || e.kind === 'symmetric') return e.d;
  if (e.kind === 'two') return which === 'd1' ? e.d1 : e.d2;
  return null;
}

/** The parameter t along the axis (origin + t axis) closest to a pointer ray. */
export function axisParamAt(origin: Vec3, axis: Vec3, ray: { origin: Vec3; dir: Vec3 }): number | null {
  const d = unitOf(ray.dir);
  const w: Vec3 = [origin[0] - ray.origin[0], origin[1] - ray.origin[1], origin[2] - ray.origin[2]];
  const b = dot(axis, d);
  const denom = 1 - b * b;
  if (denom < 1e-9) return null; // looking straight down the axis
  return (b * dot(d, w) - dot(axis, w)) / denom;
}

/** A dragged length (mm) rounded to a step a pixel can show, in the display unit, as an expression to store. */
export function roundedDistance(mm: number, pixelMm: number, units: DocUnits): { expr: string; mm: number } {
  const per = MM_PER[units.length];
  const px = Math.max(pixelMm / per, 1e-9);
  const step = Math.pow(10, Math.floor(Math.log10(px)));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const n = Number((Math.round(mm / per / step) * step).toFixed(decimals));
  return { expr: exprToStore(String(n), 'length', units), mm: n * per };
}

/** The distance fields' new values for an arrow dragged to axis parameter t. */
export function draggedExtent(f: ExtrudeFeature, which: 'd1' | 'd2', t: number, pixelMm: number, units: DocUnits): Partial<ExtrudeFeature> | null {
  const e = f.extent;
  const minMm = Math.max(pixelMm, 1e-6);
  if (e.kind === 'blind') {
    if (Math.abs(t) < minMm) return null;
    return { extent: { ...e, distance: roundedDistance(t, pixelMm, units).expr } };
  }
  if (e.kind === 'symmetric') {
    if (t < minMm / 2) return null;
    return { extent: { ...e, distance: roundedDistance(2 * t, pixelMm, units).expr } };
  }
  if (e.kind !== 'two') return null;
  if (which === 'd1') return { extent: { ...e, distance: roundedDistance(t, pixelMm, units).expr } };
  return { extent: { ...e, distance2: roundedDistance(-t, pixelMm, units).expr } };
}

/** The arrows drawn in the handle layer. */
class Arrows {
  private readonly mat: MeshBasicMaterial;
  private readonly hot: MeshBasicMaterial;
  private readonly items: { group: Group; arrow: Arrow }[] = [];
  readonly label: HTMLElement;

  constructor(
    private readonly layer: OverlayLayer,
    color: number,
  ) {
    this.mat = new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.hot = new MeshBasicMaterial({ color: PICK_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
    this.label = document.createElement('span');
    this.label.className = 'cad-extrude-value';
    this.label.dataset.extrudeValue = '1';
    this.label.style.display = 'none';
    layer.html.appendChild(this.label);
  }

  set(arrows: Arrow[]) {
    while (this.items.length > arrows.length) {
      const it = this.items.pop()!;
      this.layer.group.remove(it.group);
      for (const c of it.group.children) (c as Mesh).geometry.dispose();
    }
    while (this.items.length < arrows.length) {
      const g = new Group();
      const shaft = new Mesh(new CylinderGeometry(SHAFT_R_PX, SHAFT_R_PX, SHAFT_PX, 10), this.mat);
      shaft.position.y = SHAFT_PX / 2;
      const head = new Mesh(new ConeGeometry(HEAD_R_PX, HEAD_PX, 18), this.mat);
      head.position.y = SHAFT_PX + HEAD_PX / 2;
      for (const m of [shaft, head]) {
        m.renderOrder = 10;
        m.frustumCulled = false;
      }
      g.add(shaft, head);
      g.name = 'extrude-arrow';
      this.layer.group.add(g);
      this.items.push({ group: g, arrow: arrows[this.items.length] });
    }
    arrows.forEach((a, i) => (this.items[i].arrow = a));
    this.lit = null;
    for (const { group } of this.items) for (const c of group.children) (c as Mesh).material = this.mat;
    this.layer.changed();
  }

  /** Size and turn the arrows for the camera now (constant screen size). */
  place(handle: ViewportHandle) {
    const up = new Vector3(0, 1, 0);
    for (const { group, arrow } of this.items) {
      const s = handle.pixelSize(arrow.base);
      group.position.set(...arrow.base);
      group.quaternion.copy(new Quaternion().setFromUnitVectors(up, new Vector3(...arrow.dir).normalize()));
      group.scale.setScalar(s);
    }
  }

  private lit: 'd1' | 'd2' | null = null;

  highlight(which: 'd1' | 'd2' | null) {
    if (which === this.lit) return;
    this.lit = which;
    for (const { group, arrow } of this.items) for (const c of group.children) (c as Mesh).material = arrow.which === which ? this.hot : this.mat;
    this.layer.changed();
  }

  /** The arrow within grabbing distance of frame client coordinates, or null. */
  at(handle: ViewportHandle, x: number, y: number): Arrow | null {
    let best: { a: Arrow; d: number } | null = null;
    for (const { arrow } of this.items) {
      const s = handle.pixelSize(arrow.base);
      const p0 = handle.project(arrow.base);
      const p1 = handle.project(add(arrow.base, arrow.dir, (SHAFT_PX + HEAD_PX) * s));
      if (!p0 || !p1) continue;
      const vx = p1[0] - p0[0];
      const vy = p1[1] - p0[1];
      const l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - p0[0]) * vx + (y - p0[1]) * vy) / l2));
      const d = Math.hypot(x - (p0[0] + t * vx), y - (p0[1] + t * vy));
      if (d <= GRAB_PX && (!best || d < best.d)) best = { a: arrow, d };
    }
    return best?.a ?? null;
  }

  dispose() {
    this.set([]);
    this.mat.dispose();
    this.hot.dispose();
    this.label.remove();
  }
}

export interface PanelToolOptions {
  session: EditSession;
  /** A refused pick, in words, for the panel's foot. */
  note(text: string | null): void;
  color: number;
}

/**
 * The open Extrude panel's tool and handle. Returns a stop function; `refresh`
 * re-places the arrows after the draft or the rebuild changed.
 */
export function startPanelTool(services: AppServices, handle: ViewportHandle, opts: PanelToolOptions): { stop(): void; refresh(): void; dragging(): boolean } {
  const layer = handle.addLayer(HANDLE_LAYER, { order: 50 });
  const arrows = new Arrows(layer, opts.color);
  const view = profilesView(services);
  let geom: HandleGeometry | null = null;
  /** `grab`: where along the axis the arrow was taken, minus where its base was (the arrow keeps that offset to the pointer). */
  /** `before`: the fields a live update changed during the drag, as they were when it began (Escape puts them back). */
  let drag: { arrow: Arrow; grab: number; lastApply: number; pending: Partial<ExtrudeFeature> | null; before: Partial<ExtrudeFeature> } | null = null;
  /** The click that follows a drag's release is the drag's, not a profile pick. */
  let swallowClick = false;
  /** Escape ended a drag with the button still down: the rest of that press is the drag's. */
  let held = false;
  let stopped = false;

  const draft = () => opts.session.draft as ExtrudeFeature;
  const units = () => services.doc.state.get().doc.units;
  // The arrow says it can be dragged: a grab hand over it, a closed one while dragging (review P2/P3
  // round 2: the cursor stayed the arrow, nothing told it apart from the part).
  const canvas = layer.html.parentElement?.querySelector<HTMLCanvasElement>('canvas') ?? null;
  let cursorSet = '';
  const cursor = (c: '' | 'grab' | 'grabbing') => {
    if (!canvas || c === cursorSet) return;
    cursorSet = c;
    canvas.style.cursor = c;
  };

  const refresh = () => {
    if (stopped || drag) return;
    geom = handleGeometry(draft(), services);
    arrows.set(geom?.arrows ?? []);
    arrows.place(handle);
  };

  const showValue = (mm: number, at: Vec3) => {
    const p = handle.project(at);
    const box = layer.html.getBoundingClientRect();
    if (!p) return;
    arrows.label.textContent = formatQuantity(mm, 'length', units());
    arrows.label.style.display = '';
    arrows.label.style.transform = `translate(${(p[0] - box.left + 14).toFixed(1)}px, ${(p[1] - box.top - 10).toFixed(1)}px)`;
  };

  const apply = (patch: Partial<ExtrudeFeature> | null) => {
    if (!patch || !opts.session.open) return;
    if (drag) {
      const was = draft() as unknown as Record<string, unknown>;
      const before = drag.before as Record<string, unknown>;
      for (const k of Object.keys(patch)) if (!(k in before)) before[k] = was[k];
    }
    opts.session.update(patch);
  };

  // Escape during a drag puts the extent back as it was and keeps the panel open, as Escape does for
  // a typed field (SD review round 2: it closed the panel and kept the dragged distance).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const d = drag;
    drag = null;
    held = true;
    arrows.label.style.display = 'none';
    arrows.highlight(null);
    cursor('');
    if (Object.keys(d.before).length && opts.session.open) opts.session.update(d.before);
    refresh();
  };
  window.addEventListener('keydown', onKey, true);

  /** A click on a flat face of a body: it becomes the profile (or stops being it). */
  const toggleFace = (e: ViewportPointer): boolean => {
    const p = handle.pick(e.clientX, e.clientY);
    if (!p || p.item.kind !== 'face') return false;
    const item = p.item;
    const f = draft();
    // Up to waiting for its face or vertex: the click is its pick list's.
    if (f.extent.kind === 'to' && !f.extent.target) return false;
    if (f.profiles.length) {
      opts.note('Extrude takes sketch profiles or one flat face: remove the profiles to extrude a face');
      return true;
    }
    if (!handle.planeNormal(item)) {
      opts.note('Extrude takes a flat face: that face is curved');
      return true;
    }
    const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
    if (!info) return true;
    void pickFace(services, info, item.index, f.id).then((r) => {
      if (!r.ok) {
        opts.note(r.reason);
        return;
      }
      opts.note(null);
      const now = draft();
      if (now.face && now.face.ref.name === r.ref.name) {
        apply({ face: null });
        return;
      }
      apply({ face: { body: r.body, ref: r.ref }, ...(opts.session.isNew && now.op === 'new' ? { op: 'join' as const } : {}) });
    });
    return true;
  };

  const toggleProfile = (e: ViewportPointer): boolean => {
    const hit = regionUnder(services, e);
    if (!hit) return toggleFace(e);
    if (draft().face) {
      opts.note('Extrude takes one flat face or sketch profiles: remove the face to pick profiles');
      return true;
    }
    const f = draft();
    const s = services.doc.state.get();
    const from = f.profiles[0]?.sketch;
    if (from && hit.feature !== from) {
      const name = (id: string) => s.doc.features.find((g) => g.id === id)?.name ?? 'another sketch';
      opts.note(`Pick profiles from one sketch: ${f.name} uses ${name(from)}, this profile is in ${name(hit.feature)}`);
      return true;
    }
    // A feature reads only what comes before it in the history.
    const at = (id: string) => s.doc.features.findIndex((g) => g.id === id);
    if (at(f.id) >= 0 && at(hit.feature) > at(f.id)) {
      const name = s.doc.features[at(hit.feature)]?.name ?? 'That sketch';
      opts.note(`${name} comes after ${f.name} in the history: pick a profile of a sketch above it`);
      return true;
    }
    const out = sketchOutput(s, hit.feature);
    if (!out) return true;
    const sketch = s.doc.features.find((g) => g.id === hit.feature);
    const parents = entityParents(sketch && sketch.type === 'sketch' ? sketch.entities : []);
    // The user's edit re-anchors every profile still found (its key, entities and inside point now).
    let removed = false;
    const next = [];
    for (const p of f.profiles) {
      const r = resolveRegionRef(p, out.regions, parents);
      if (r.ok && r.key === hit.key) {
        removed = true;
        continue;
      }
      next.push(r.ok ? refOfRegion(hit.feature, r.region) : p);
    }
    if (!removed) next.push(refOfRegion(hit.feature, hit.region));
    opts.note(null);
    apply({ profiles: next });
    return true;
  };

  const tool: ViewportTool = {
    id: PANEL_TOOL_ID,
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
        if (e.type === 'move') {
          const at = geom ? axisParamAt(geom.origin, geom.axis, e.ray) : null;
          if (at == null || !geom) return true;
          const t = at - drag.grab;
          const px = handle.pixelSize(drag.arrow.base);
          const patch = draggedExtent(draft(), drag.arrow.which, t, px, units());
          if (!patch) return true;
          drag.pending = patch;
          // The arrow follows the pointer (a blind arrow turns round when it crosses the profile).
          const a = drag.arrow;
          a.base = [geom.origin[0] + geom.axis[0] * t, geom.origin[1] + geom.axis[1] * t, geom.origin[2] + geom.axis[2] * t];
          if (geom.extent.kind === 'blind') a.dir = t < 0 ? [-geom.axis[0], -geom.axis[1], -geom.axis[2]] : geom.axis;
          arrows.place(handle);
          layer.changed();
          const shown = resolveExtent({ extent: patch.extent! }, services.doc.units);
          const mm = shown.ok ? (extentLength(shown.values, drag.arrow.which) ?? t) : t;
          showValue(mm, [geom.origin[0] + geom.axis[0] * t, geom.origin[1] + geom.axis[1] * t, geom.origin[2] + geom.axis[2] * t]);
          const now = performance.now();
          if (now - drag.lastApply >= DRAG_APPLY_MS && services.doc.state.get().rebuild.status !== 'running') {
            drag.lastApply = now;
            apply(patch);
            drag.pending = null;
          }
          return true;
        }
        if (e.type === 'up' || e.type === 'leave') {
          const d = drag;
          drag = null;
          swallowClick = e.type === 'up';
          arrows.label.style.display = 'none';
          arrows.highlight(null);
          cursor(e.type === 'up' && arrows.at(handle, e.clientX, e.clientY) ? 'grab' : '');
          apply(d.pending);
          refresh();
          return true;
        }
        return true;
      }
      if (e.type === 'down' && e.button === 0 && !e.alt) {
        const a = arrows.at(handle, e.clientX, e.clientY);
        if (!a || !geom) return false;
        const at = axisParamAt(geom.origin, geom.axis, e.ray);
        const base = (a.base[0] - geom.origin[0]) * geom.axis[0] + (a.base[1] - geom.origin[1]) * geom.axis[1] + (a.base[2] - geom.origin[2]) * geom.axis[2];
        drag = { arrow: a, grab: at == null ? 0 : at - base, lastApply: 0, pending: null, before: {} };
        arrows.highlight(a.which);
        cursor('grabbing');
        return true;
      }
      if (e.type === 'move' && !e.buttons) {
        const a = arrows.at(handle, e.clientX, e.clientY);
        arrows.highlight(a?.which ?? null);
        cursor(a ? 'grab' : '');
        if (a) {
          if (view.get().hover) view.set({ hover: null });
          return true;
        }
        const hit = regionUnder(services, e);
        const h = hit ? { feature: hit.feature, key: hit.key } : null;
        const was = view.get().hover;
        if (was?.feature !== h?.feature || was?.key !== h?.key) view.set({ hover: h });
        return !!hit;
      }
      if (e.type === 'click' && swallowClick) {
        swallowClick = false;
        return true;
      }
      swallowClick = false;
      if (e.type === 'click' && e.button === 0) return toggleProfile(e);
      if (e.type === 'leave') {
        arrows.highlight(null);
        cursor('');
        if (view.get().hover) view.set({ hover: null });
      }
      return false;
    },
  };
  const pop = handle.pushTool(tool);
  const offFrame = handle.onFrame(() => arrows.place(handle));
  refresh();
  return {
    refresh,
    dragging: () => !!drag,
    stop() {
      if (stopped) return;
      stopped = true;
      window.removeEventListener('keydown', onKey, true);
      cursor('');
      pop();
      offFrame();
      arrows.dispose();
      layer.dispose();
    },
  };
}
