// The CONSTRUCT layer in the viewport (layer `construct`, order 15): reference
// planes as translucent squares with a border (the origin planes' look), axes
// as dashed lines, points as small dots, each with its name beside it ("Plane
// 1", as the origin planes' labels). Hovered items (the pointer, or its tree
// row) light in the hover blue; selected ones, and the one a panel edits, in
// the pick green. Reads scene.ts (what is drawn), the selection and the
// overlay's hover state; nobody pushes geometry into it.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, DoubleSide, Float32BufferAttribute, LineBasicMaterial, LineLoop, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector3, type Object3D } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { floatingRects } from '../../lib/chrome';
import type { AppServices } from '../../types/app';
import type { FeatureId, Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';
import { HOVER_COLOR, PICK_COLOR, PLANE_BORDER, PLANE_FILL, PLANE_HOVER_FILL, PLANE_PICK_FILL } from '../../viewport/colors';
import { constructView, drawnConstructs, drawnOriginAxes, isOriginAxis, ORIGIN_AXIS_REFS, type DrawnConstruct } from './scene';

export const LAYER_CONSTRUCT = 'construct';
/** Axis line widths (CSS px) and the dot's radius (CSS px). */
const AXIS_PX = 1.6;
const AXIS_ACTIVE_PX = 2.6;
const DOT_PX = 4;
/** Axis and point colour at rest: the planes' border blue, darker. */
const LINE_COLOR = 0x2f5fb8;

export type ConstructState = 'none' | 'hover' | 'pick';

interface Drawn {
  c: DrawnConstruct;
  objects: Object3D[];
  label: HTMLSpanElement;
  labelSize?: { w: number; h: number };
  state: ConstructState;
  fill?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  border?: LineLoop<BufferGeometry, LineBasicMaterial>;
  line?: LineSegments2;
  dot?: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** The faint copy seen through bodies (an axis through a cylinder, a point inside a part). */
  xline?: LineSegments2;
  xdot?: Mesh<SphereGeometry, MeshBasicMaterial>;
}

const overlays = new WeakMap<AppServices, ConstructOverlay>();
/** The app's CONSTRUCT overlay (tests read what it draws). */
export function constructOverlayOf(services: AppServices): ConstructOverlay | null {
  return overlays.get(services) ?? null;
}

export class ConstructOverlay {
  private readonly layer: OverlayLayer;
  private readonly drawn = new Map<FeatureId, Drawn>();
  private list: DrawnConstruct[] = [];
  private readonly offs: (() => void)[] = [];
  private queued = false;
  private readonly lineMats: Record<ConstructState, LineMaterial>;
  private readonly fills: Record<ConstructState, MeshBasicMaterial>;
  private readonly dots: Record<ConstructState, MeshBasicMaterial>;
  private readonly xlineMats: Record<ConstructState, LineMaterial>;
  private readonly xdots: Record<ConstructState, MeshBasicMaterial>;

  constructor(
    private readonly services: AppServices,
    private readonly handle: ViewportHandle,
  ) {
    // Points, and the middles of axes and planes, count when the view frames the part (Fit, the
    // standard views): a point off the part is brought into view; their extents (sized to the bodies) do not.
    this.layer = handle.addLayer(LAYER_CONSTRUCT, { order: 15, frame: () => this.frameBox() });
    this.layer.html.dataset.constructLayer = '1';
    const line = (color: number, width: number) => {
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false, dashed: true, transparent: true, opacity: 0.95 });
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -8;
      return m;
    };
    this.lineMats = { none: line(LINE_COLOR, AXIS_PX), hover: line(HOVER_COLOR, AXIS_ACTIVE_PX), pick: line(PICK_COLOR, AXIS_ACTIVE_PX) };
    // The origin planes' fills: seen from both sides, no depth writes, behind a coplanar body face.
    const fill = (k: { color: number; opacity: number }) =>
      new MeshBasicMaterial({ color: k.color, transparent: true, opacity: k.opacity, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
    this.fills = { none: fill(PLANE_FILL), hover: fill(PLANE_HOVER_FILL), pick: fill(PLANE_PICK_FILL) };
    this.dots = { none: new MeshBasicMaterial({ color: LINE_COLOR }), hover: new MeshBasicMaterial({ color: HOVER_COLOR }), pick: new MeshBasicMaterial({ color: PICK_COLOR }) };
    // Seen through bodies, faintly: an axis inside a cylinder, a point inside a part.
    const xline = (color: number, width: number) => new LineMaterial({ color, linewidth: width, worldUnits: false, dashed: true, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false });
    this.xlineMats = { none: xline(LINE_COLOR, AXIS_PX), hover: xline(HOVER_COLOR, AXIS_ACTIVE_PX), pick: xline(PICK_COLOR, AXIS_ACTIVE_PX) };
    const xdot = (color: number) => new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false });
    this.xdots = { none: xdot(LINE_COLOR), hover: xdot(HOVER_COLOR), pick: xdot(PICK_COLOR) };
    const later = () => this.later();
    this.offs.push(services.doc.state.subscribe(later), services.selection.subscribe(later), services.mode.subscribe(later), constructView(services).subscribe(later), handle.onFrame(() => this.place()));
    overlays.set(services, this);
    this.sync();
  }

  private frameBox(): { min: Vec3; max: Vec3 } | null {
    const pts: Vec3[] = [];
    for (const c of this.list) {
      // The origin's axes run across the part: they do not move the framing.
      if (isOriginAxis(c.feature)) continue;
      if (c.point) pts.push(c.point);
      else if (c.plane) pts.push(c.plane.center);
      else if (c.axis) pts.push([(c.axis.a[0] + c.axis.b[0]) / 2, (c.axis.a[1] + c.axis.b[1]) / 2, (c.axis.a[2] + c.axis.b[2]) / 2]);
    }
    if (!pts.length) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    return { min, max };
  }

  /** What is drawn now (picking reads the same list). */
  items(): readonly DrawnConstruct[] {
    return this.list;
  }

  /** Each drawn item's state (tests). */
  states(): Record<FeatureId, ConstructState> {
    return Object.fromEntries([...this.drawn].map(([id, d]) => [id, d.state]));
  }

  private later() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.sync();
    });
  }

  sync(): void {
    const s = this.services.doc.state.get();
    const mode = this.services.mode.get().mode;
    const v = constructView(this.services).get();
    const items = this.services.selection.get().items;
    // The origin's axes: while a field wants them, or selected / hovered (their tree rows).
    const axes = mode === 'model' ? ORIGIN_AXIS_REFS.filter((r) => v.originAxes.length > 0 || v.hover === r || v.flash === r || items.some((it) => it.kind === 'origin' && it.ref === r)) : [];
    this.list = [...drawnConstructs(s, mode), ...drawnOriginAxes(s, axes)];
    const keep = new Set(this.list.map((c) => c.feature));
    for (const [id, d] of this.drawn) {
      if (!keep.has(id)) {
        this.drop(d);
        this.drawn.delete(id);
      }
    }
    for (const c of this.list) {
      const was = this.drawn.get(c.feature);
      if (was && sameDrawn(was.c, c)) {
        was.c = c;
        if (was.label.textContent !== c.name) {
          was.label.textContent = c.name;
          was.labelSize = undefined;
        }
        continue;
      }
      if (was) this.drop(was);
      this.drawn.set(c.feature, this.make(c));
    }
    // States: selected or being edited -> pick; hovered (pointer or a row) -> hover.
    const picked = new Set<FeatureId>();
    for (const it of items) {
      if (it.kind === 'feature') picked.add(it.feature);
      else if (it.kind === 'origin' && isOriginAxis(it.ref)) picked.add(it.ref);
    }
    if (s.session) picked.add(s.session.feature);
    for (const [id, d] of this.drawn) {
      const st: ConstructState = picked.has(id) ? 'pick' : id === v.hover || id === v.flash ? 'hover' : 'none';
      if (st === d.state && d.label.dataset.state === st) continue;
      d.state = st;
      d.label.dataset.state = st;
      if (d.fill) d.fill.material = this.fills[st];
      if (d.border) {
        d.border.material.color.setHex(st === 'pick' ? PICK_COLOR : st === 'hover' ? HOVER_COLOR : PLANE_BORDER.color);
        d.border.material.opacity = st === 'none' ? PLANE_BORDER.opacity : 0.9;
      }
      if (d.line) d.line.material = this.lineMats[st];
      if (d.dot) d.dot.material = this.dots[st];
      if (d.xline) d.xline.material = this.xlineMats[st];
      if (d.xdot) d.xdot.material = this.xdots[st];
    }
    this.place();
    this.layer.changed();
  }

  private make(c: DrawnConstruct): Drawn {
    const objects: Object3D[] = [];
    const label = document.createElement('span');
    label.className = 'cad-vp-label cad-construct-label';
    label.textContent = c.name;
    label.dataset.constructLabel = c.feature;
    label.dataset.kind = c.kind;
    label.dataset.state = 'none';
    this.layer.html.appendChild(label);
    const d: Drawn = { c, objects, label, state: 'none' };
    if (c.plane) {
      const p = c.plane;
      const n = new Vector3(...p.frame.normal).normalize();
      const m = new Matrix4().makeBasis(new Vector3(...p.u).multiplyScalar(p.half), new Vector3(...p.v).multiplyScalar(p.half), n.multiplyScalar(p.half));
      m.setPosition(new Vector3(...p.center));
      const fill = new Mesh(new PlaneGeometry(2, 2), this.fills.none);
      fill.matrixAutoUpdate = false;
      fill.matrix.copy(m);
      fill.renderOrder = 10;
      fill.name = `construct:${c.feature}`;
      const border = new LineLoop(
        new BufferGeometry().setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)),
        new LineBasicMaterial({ color: PLANE_BORDER.color, transparent: true, opacity: PLANE_BORDER.opacity, depthWrite: false }),
      );
      border.matrixAutoUpdate = false;
      border.matrix.copy(m);
      border.renderOrder = 11;
      objects.push(fill, border);
      d.fill = fill;
      d.border = border;
    } else if (c.axis) {
      const g = new LineSegmentsGeometry();
      g.setPositions([...c.axis.a, ...c.axis.b]);
      const line = new LineSegments2(g, this.lineMats.none);
      line.computeLineDistances();
      line.renderOrder = 12;
      line.name = `construct:${c.feature}`;
      const x = new LineSegments2(g, this.xlineMats.none);
      x.computeLineDistances();
      x.renderOrder = 9;
      objects.push(x, line);
      d.line = line;
      d.xline = x;
    } else if (c.point) {
      const dot = new Mesh(new SphereGeometry(1, 14, 10), this.dots.none);
      dot.position.set(...c.point);
      dot.renderOrder = 13;
      dot.name = `construct:${c.feature}`;
      const x = new Mesh(dot.geometry, this.xdots.none);
      x.position.copy(dot.position);
      x.renderOrder = 9;
      objects.push(x, dot);
      d.dot = dot;
      d.xdot = x;
    }
    for (const o of objects) {
      o.frustumCulled = false;
      this.layer.group.add(o);
    }
    return d;
  }

  private drop(d: Drawn) {
    for (const o of d.objects) {
      this.layer.group.remove(o);
      const g = (o as Object3D & { geometry?: { dispose(): void } }).geometry;
      g?.dispose();
      if (o instanceof LineLoop) (o.material as LineBasicMaterial).dispose();
    }
    d.label.remove();
  }

  /** Re-place labels, dot sizes and dash lengths for the camera now (after every frame). */
  private place(): void {
    // Nothing drawn: no layout reads on every frame.
    if (!this.drawn.size) return;
    const h = this.handle;
    const [rw, rh] = h.lineResolution();
    for (const m of [...Object.values(this.lineMats), ...Object.values(this.xlineMats)]) m.resolution.set(rw, rh);
    const frame = this.layer.html.getBoundingClientRect();
    // What floats over the view, then each label placed so far (two labels never overlap).
    const blocked = frame.width ? floatingRects(this.layer.html.ownerDocument) : [];
    for (const d of this.drawn.values()) {
      const c = d.c;
      if (d.dot && c.point) {
        const r = h.pixelSize(c.point) * DOT_PX;
        if (Number.isFinite(r) && r > 0) {
          d.dot.scale.setScalar(r);
          d.xdot?.scale.setScalar(r);
        }
      }
      if (d.line && c.axis) {
        const mid: Vec3 = [(c.axis.a[0] + c.axis.b[0]) / 2, (c.axis.a[1] + c.axis.b[1]) / 2, (c.axis.a[2] + c.axis.b[2]) / 2];
        const px = h.pixelSize(mid);
        if (Number.isFinite(px) && px > 0) {
          const mat = d.line.material as LineMaterial;
          // A long dash and a short gap, about 14 and 5 px at the axis's middle (the dash follows the zoom).
          if (Math.abs(mat.dashSize - 14 * px) > 1e-3 * px) {
            for (const m of [mat, d.xline?.material as LineMaterial | undefined]) {
              if (!m) continue;
              m.dashSize = 14 * px;
              m.gapSize = 5 * px;
            }
            this.layer.changed();
          }
        }
      }
      const r = this.placeLabel(d, frame, blocked);
      if (r) blocked.push(r);
    }
  }

  private placeLabel(d: Drawn, frame: DOMRect, blocked: readonly { left: number; top: number; right: number; bottom: number }[]): { left: number; top: number; right: number; bottom: number } | null {
    const h = this.handle;
    const c = d.c;
    if (!d.labelSize || !d.labelSize.w) d.labelSize = { w: d.label.offsetWidth || 40, h: d.label.offsetHeight || 11 };
    const { w, h: lh } = d.labelSize;
    const spots: [number, number][] = [];
    if (c.plane) {
      const p = c.plane;
      for (const [a, b] of [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ]) {
        const corner: Vec3 = [p.center[0] + (p.u[0] * a + p.v[0] * b) * p.half, p.center[1] + (p.u[1] * a + p.v[1] * b) * p.half, p.center[2] + (p.u[2] * a + p.v[2] * b) * p.half];
        const s = h.project(corner);
        if (s) spots.push([s[0] + 4, s[1] - lh - 3]);
      }
      // The topmost corner first: labels read above the square.
      spots.sort((m, n) => m[1] - n[1]);
    } else if (c.axis) {
      for (const end of [c.axis.b, c.axis.a]) {
        const s = h.project(end);
        if (s) spots.push([s[0] + 6, s[1] - lh - 4], [s[0] + 6, s[1] + 4], [s[0] - w - 6, s[1] - lh - 4], [s[0] - w - 6, s[1] + 4]);
      }
    } else if (c.point) {
      const s = h.project(c.point);
      if (s) spots.push([s[0] + 8, s[1] - lh - 6], [s[0] - w - 8, s[1] - lh - 6], [s[0] + 8, s[1] + 6], [s[0] - w - 8, s[1] + 6]);
    }
    // Spots are frame client px: inside the view, clear of what floats over it (the tree, a panel, the dock).
    const inView = (x: number, y: number) => !frame.width || (x >= frame.left && y >= frame.top && x + w <= frame.right && y + lh <= frame.bottom);
    // Not over a body either (a label on a face reads as part of it): one pick at the label's middle.
    // Its middle and its four corners (P4a review: a label whose middle cleared the body still sat on it).
    const overBody = (x: number, y: number) =>
      [
        [x + w / 2, y + lh / 2],
        [x + 1, y + 1],
        [x + w - 1, y + 1],
        [x + 1, y + lh - 1],
        [x + w - 1, y + lh - 1],
      ].some(([px, py]) => {
        const p = h.pick(px, py);
        // A face under it (an edge or a vertex near it is only within the pick radius, not under it).
        return !!p && p.item.kind === 'face';
      });
    const free = spots.filter(([x, y]) => inView(x, y) && !blocked.some((b) => x < b.right && b.left < x + w && y < b.bottom && b.top < y + lh));
    const at = free.find(([x, y]) => !overBody(x, y)) ?? null;
    if (!at) {
      d.label.style.display = 'none';
      return null;
    }
    d.label.style.display = '';
    d.label.style.transform = `translate(${Math.round(at[0] - frame.left)}px, ${Math.round(at[1] - frame.top)}px)`;
    // A gap of 8 px to the next label (P4a review: "Plane 2" and "Plane 3" nearly touched).
    return { left: at[0] - 8, top: at[1] - 4, right: at[0] + w + 8, bottom: at[1] + lh + 4 };
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    for (const d of this.drawn.values()) this.drop(d);
    this.drawn.clear();
    for (const m of [...Object.values(this.lineMats), ...Object.values(this.xlineMats), ...Object.values(this.fills), ...Object.values(this.dots), ...Object.values(this.xdots)]) m.dispose();
    this.layer.dispose();
    if (overlays.get(this.services) === this) overlays.delete(this.services);
  }
}

function sameVec(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameDrawn(a: DrawnConstruct, b: DrawnConstruct): boolean {
  if (a.kind !== b.kind) return false;
  if (a.plane && b.plane) return sameVec(a.plane.center, b.plane.center) && sameVec(a.plane.frame.normal, b.plane.frame.normal) && sameVec(a.plane.u, b.plane.u) && a.plane.half === b.plane.half;
  if (a.axis && b.axis) return sameVec(a.axis.a, b.axis.a) && sameVec(a.axis.b, b.axis.b);
  if (a.point && b.point) return sameVec(a.point, b.point);
  return false;
}
