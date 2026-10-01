// The origin planes (Top / Front / Right, ORIGIN_PLANES) as translucent squares
// with a border and an HTML label at one corner. Each square covers the shown
// bodies' footprint on its plane and the origin, with a margin (as SOLIDWORKS
// sizes its planes to the model), so it frames with the part instead of
// reaching far past it on the side away from the part. They hover and select like
// faces. They sit behind coplanar body faces (polygon offset) so a face on an
// origin plane shows its own colour. In the default "auto" mode they are drawn
// on an empty part, and otherwise only while selected or hovered (in the tree
// or the viewport), as SOLIDWORKS shows a hidden plane you select.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Box3, BufferGeometry, DoubleSide, Float32BufferAttribute, Group, LineBasicMaterial, LineLoop, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { ORIGIN_PLANES, type OriginPlaneRef } from '../types/doc';
import { PLANE_BORDER, PLANE_FILL, PLANE_HOVER_FILL, PLANE_PICK_FILL, PICK_COLOR } from './colors';
import type { PickPlane } from './pick';

export const PLANE_REFS: OriginPlaneRef[] = ['origin:top', 'origin:front', 'origin:right'];
/** Short labels drawn in the viewport (the tree says "Top plane"). */
export const PLANE_LABELS: Record<OriginPlaneRef, string> = { 'origin:top': 'Top', 'origin:front': 'Front', 'origin:right': 'Right' };
/** Half-size of the planes with nothing else in the scene (mm). */
export const EMPTY_PLANE_HALF = 50;

export type PlaneState = 'none' | 'hover' | 'pick';

interface PlaneObj {
  pick: PickPlane;
  fill: Mesh<PlaneGeometry, MeshBasicMaterial>;
  border: LineLoop<BufferGeometry, LineBasicMaterial>;
  label: HTMLSpanElement;
  /** The label's size, measured once it is laid out (its text does not change). */
  labelSize?: { w: number; h: number };
  state: PlaneState;
}

/** A plane's corners, as (u, v) signs, in the order tried when there is no body: (+u, +v) first. */
const CORNERS: [number, number][] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

export class OriginPlanes {
  readonly group = new Group();
  readonly labels: HTMLDivElement;
  private planes = new Map<OriginPlaneRef, PlaneObj>();
  /** Sized to bodies at least once. */
  private sized = false;

  constructor(labelHost: HTMLElement) {
    this.group.name = 'origin-planes';
    this.labels = document.createElement('div');
    this.labels.className = 'cad-vp-labels';
    labelHost.appendChild(this.labels);
    for (const ref of PLANE_REFS) {
      const def = ORIGIN_PLANES[ref];
      const normal = new Vector3(...def.normal).normalize();
      const u = new Vector3(...def.xdir).normalize();
      const v = new Vector3().crossVectors(normal, u).normalize();
      const fill = new Mesh(
        new PlaneGeometry(2, 2),
        new MeshBasicMaterial({
          color: PLANE_FILL.color,
          transparent: true,
          opacity: PLANE_FILL.opacity,
          side: DoubleSide,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: 2,
          polygonOffsetUnits: 8,
        }),
      );
      // PlaneGeometry lies in XY with normal +Z: turn it so X -> u, Y -> v, Z -> normal.
      fill.matrixAutoUpdate = false;
      fill.renderOrder = 10;
      fill.name = ref;
      const border = new LineLoop(
        new BufferGeometry().setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3)),
        new LineBasicMaterial({ color: PLANE_BORDER.color, transparent: true, opacity: PLANE_BORDER.opacity, depthWrite: false }),
      );
      border.matrixAutoUpdate = false;
      border.renderOrder = 11;
      this.group.add(fill, border);
      const label = document.createElement('span');
      label.className = 'cad-vp-label';
      label.textContent = PLANE_LABELS[ref];
      label.dataset.planeLabel = ref;
      this.labels.appendChild(label);
      this.planes.set(ref, { pick: { ref, origin: new Vector3(...def.origin), normal, u, v, half: EMPTY_PLANE_HALF }, fill, border, label, state: 'none' });
    }
    this.place(null);
  }

  /**
   * Size the planes to the shown bodies: each square covers their footprint on
   * its plane and the origin, 15 % wider. With no body shown (rolled to the
   * start, every body suppressed or hidden) they keep the size the part last
   * gave them, so they do not fill a view fitted to a small part (review round
   * 2); EMPTY_PLANE_HALF around the origin is for a part that has shown no body yet.
   */
  fitTo(bounds: Box3 | null): void {
    if (!bounds || bounds.isEmpty()) {
      if (!this.sized) this.place(null);
      return;
    }
    this.sized = true;
    this.place(bounds);
  }

  private place(bounds: Box3 | null): void {
    const corners: Vector3[] = [];
    if (bounds) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(new Vector3(x, y, z));
    for (const p of this.planes.values()) {
      const { u, v, normal } = p.pick;
      const at = new Vector3(...ORIGIN_PLANES[p.pick.ref].origin);
      let half = EMPTY_PLANE_HALF;
      if (corners.length) {
        // The footprint in the plane's (u, v), with the origin in it.
        let u0 = 0;
        let u1 = 0;
        let v0 = 0;
        let v1 = 0;
        for (const c of corners) {
          const du = c.dot(u);
          const dv = c.dot(v);
          u0 = Math.min(u0, du);
          u1 = Math.max(u1, du);
          v0 = Math.min(v0, dv);
          v1 = Math.max(v1, dv);
        }
        half = Math.max((Math.max(u1 - u0, v1 - v0) / 2) * 1.15, 1e-3);
        at.addScaledVector(u, (u0 + u1) / 2).addScaledVector(v, (v0 + v1) / 2);
      }
      p.pick.half = half;
      p.pick.origin.copy(at);
      const m = p.fill.matrix;
      m.makeBasis(u.clone().multiplyScalar(half), v.clone().multiplyScalar(half), normal.clone().multiplyScalar(half));
      m.setPosition(at);
      p.border.matrix.copy(m);
      p.fill.matrixWorldNeedsUpdate = true;
      p.border.matrixWorldNeedsUpdate = true;
    }
  }

  /** The largest plane's half-size (mm). */
  get halfSize(): number {
    return Math.max(...[...this.planes.values()].map((p) => p.pick.half));
  }

  /** The box the three squares fill (for framing an empty part and the camera's clip range). */
  box(): Box3 {
    const out = new Box3();
    for (const p of this.planes.values()) {
      const { u, v, origin, half } = p.pick;
      for (const [a, b] of CORNERS) out.expandByPoint(origin.clone().addScaledVector(u, a * half).addScaledVector(v, b * half));
    }
    return out;
  }

  /**
   * Which planes are drawn: all of them when `all`, otherwise only those
   * hovered or selected. Returns whether anything changed.
   */
  setShown(all: boolean): boolean {
    let changed = false;
    for (const p of this.planes.values()) {
      const v = all || p.state !== 'none';
      if (p.fill.visible === v) continue;
      p.fill.visible = v;
      p.border.visible = v;
      changed = true;
    }
    return changed;
  }

  /** Planes a pick can hit (the drawn ones). */
  picks(): PickPlane[] {
    return this.group.visible ? [...this.planes.values()].filter((p) => p.fill.visible).map((p) => p.pick) : [];
  }

  setState(states: Partial<Record<OriginPlaneRef, PlaneState>>): boolean {
    let changed = false;
    for (const [ref, p] of this.planes) {
      const s = states[ref] ?? 'none';
      if (s === p.state) continue;
      changed = true;
      p.state = s;
      const f = s === 'pick' ? PLANE_PICK_FILL : s === 'hover' ? PLANE_HOVER_FILL : PLANE_FILL;
      p.fill.material.color.setHex(f.color);
      p.fill.material.opacity = f.opacity;
      p.border.material.color.setHex(s === 'pick' ? PICK_COLOR : PLANE_BORDER.color);
      p.border.material.opacity = s === 'none' ? PLANE_BORDER.opacity : 0.9;
      p.label.dataset.state = s;
    }
    return changed;
  }

  /**
   * Place the labels. Each sits just outside a corner of its plane, on the side
   * away from the plane's centre, at the first corner (farthest from the
   * bodies first: `away` is the shown bodies' centre) where the whole label is
   * on the canvas (`size`) and over no body (`covered` says whether a body is
   * under a canvas pixel). Labels are HTML on top of the canvas, so a body
   * would not hide one (review round 2: "Front" over the box edge). A label is
   * hidden for a plane seen edge-on, or when no corner works.
   */
  placeLabels(
    project: (p: Vector3) => [number, number] | null,
    viewDir: Vector3,
    opts: { away?: Vector3 | null; covered?: (x: number, y: number) => boolean; size?: { w: number; h: number } } = {},
  ): void {
    const show = this.group.visible;
    const away = opts.away ?? null;
    const covered = opts.covered;
    const size = opts.size;
    for (const p of this.planes.values()) {
      const { u, v, origin, normal, half } = p.pick;
      const c = show && p.fill.visible && Math.abs(normal.dot(viewDir)) > 0.12 ? project(origin) : null;
      if (!c) {
        p.label.style.display = 'none';
        continue;
      }
      p.label.style.display = '';
      if (!p.labelSize || !p.labelSize.w) p.labelSize = { w: p.label.offsetWidth, h: p.label.offsetHeight };
      const w = p.labelSize.w || 32;
      const h = p.labelSize.h || 11;
      const corners = CORNERS.map(([a, b]) => origin.clone().addScaledVector(u, a * half).addScaledVector(v, b * half));
      if (away) corners.sort((m, n) => n.distanceToSquared(away) - m.distanceToSquared(away));
      let at: [number, number] | null = null;
      for (const corner of corners) {
        const s = project(corner);
        if (!s) continue;
        // Outside the square: beyond the corner, away from the plane's centre on screen.
        const x = s[0] >= c[0] ? s[0] + 4 : s[0] - w - 4;
        const y = s[1] >= c[1] ? s[1] + 3 : s[1] - h - 3;
        if (size && (x < 0 || y < 0 || x + w > size.w || y + h > size.h)) continue;
        if (covered && [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y + h / 2]].some(([px, py]) => covered(px, py))) continue;
        at = [x, y];
        break;
      }
      if (!at) {
        p.label.style.display = 'none';
        continue;
      }
      p.label.style.transform = `translate(${Math.round(at[0])}px, ${Math.round(at[1])}px)`;
    }
  }

  dispose(): void {
    for (const p of this.planes.values()) {
      p.fill.geometry.dispose();
      p.fill.material.dispose();
      p.border.geometry.dispose();
      p.border.material.dispose();
    }
    this.labels.remove();
  }
}
