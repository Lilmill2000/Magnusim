// What the viewport draws for CONSTRUCT features, as plain data (unit-tested):
// each built reference Plane as a square sized to the shown bodies (as the
// origin planes are: their footprint on it, 15 % wider), each Axis as a segment
// across the bodies, each Point as a marker. Shown unless the tree's eye hid it
// (CadView.sketches holds the choice per feature id, as for sketches); planes
// are left out in sketch mode (the sketch's own plane and grid are drawn
// there), axes and points stay. Picking works on the same data (ray and screen
// tests, src/features/refgeom/pick.ts). The origin's X, Y and Z axes are drawn the
// same way (ids 'origin:x' ...) while selected or hovered (their tree rows), and
// while a field that takes an axis is active (Revolve's Axis, Extrude's Along, a
// CONSTRUCT axis field: `wantOriginAxes`), so they can be clicked in the view (P4a review).
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { Mode } from '../../types/commands';
import type { FeatureId, OriginAxisRef, PlaneFrame, Vec3 } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { StateStore } from '../../types/state';
import { constructKindOfType, constructOutput, type ConstructKind } from './api';
import { add, cross, dot, scale, sub, unit } from './geom';

/** Half-size of a plane (and half-length of an axis) with no body shown (mm), as the origin planes. */
export const EMPTY_HALF = 50;

export interface DrawnPlane {
  frame: PlaneFrame;
  /** The square's centre (on the plane), its in-plane directions and half-size (mm). */
  center: Vec3;
  u: Vec3;
  v: Vec3;
  half: number;
}

export interface DrawnConstruct {
  feature: FeatureId;
  name: string;
  kind: ConstructKind;
  plane?: DrawnPlane;
  /** An axis: the segment drawn (mm). */
  axis?: { a: Vec3; b: Vec3; dir: Vec3 };
  point?: Vec3;
}

/** The overlay's shared state: what is drawn, and what the pointer is over (or a tree row hovers). */
export interface ConstructViewState {
  hover: FeatureId | null;
  /** A tree row or a panel row hovering (flash), drawn as hover too. */
  flash: FeatureId | null;
  /** Owners (active pick fields) that want the origin's axes drawn and pickable. */
  originAxes: readonly string[];
}

/** The origin's axes, as the overlay draws them ("X axis" ...). */
export const ORIGIN_AXIS_REFS: readonly OriginAxisRef[] = ['origin:x', 'origin:y', 'origin:z'];
export const ORIGIN_AXIS_NAMES: Record<OriginAxisRef, string> = { 'origin:x': 'X axis', 'origin:y': 'Y axis', 'origin:z': 'Z axis' };
const ORIGIN_AXIS_DIRS: Record<OriginAxisRef, Vec3> = { 'origin:x': [1, 0, 0], 'origin:y': [0, 1, 0], 'origin:z': [0, 0, 1] };

/** Whether a drawn item's id is one of the origin's axes (not a feature). */
export function isOriginAxis(id: string | null | undefined): id is OriginAxisRef {
  return id === 'origin:x' || id === 'origin:y' || id === 'origin:z';
}

/** An active pick field wants the origin's axes drawn (on) or no longer (off). */
export function wantOriginAxes(services: AppServices, owner: string, on: boolean): void {
  const v = constructView(services);
  const now = v.get().originAxes;
  if (now.includes(owner) === on) return;
  v.set({ originAxes: on ? [...now, owner] : now.filter((o) => o !== owner) });
}

/** The origin's axes `which` drawn across the shown bodies (as a CONSTRUCT axis is). */
export function drawnOriginAxes(s: Pick<DocState, 'rebuild'>, which: readonly OriginAxisRef[]): DrawnConstruct[] {
  if (!which.length) return [];
  const corners = bodyCorners(s);
  return which.map((ref) => ({ feature: ref, name: ORIGIN_AXIS_NAMES[ref], kind: 'axis' as const, axis: axisSegment([0, 0, 0], ORIGIN_AXIS_DIRS[ref], corners) }));
}

const views = new WeakMap<AppServices, StateStore<ConstructViewState>>();

export function constructView(services: AppServices): StateStore<ConstructViewState> {
  let s = views.get(services);
  if (!s) {
    s = createStateStore<ConstructViewState>({ hover: null, flash: null, originAxes: [] });
    views.set(services, s);
  }
  return s;
}

/** Whether a CONSTRUCT feature is shown (the tree's eye; shown unless hidden). */
export function constructShown(view: Pick<DocState['view'], 'sketches'>, id: FeatureId): boolean {
  return view.sketches?.[id] !== 'hidden';
}

/** The corners of the shown bodies' boxes (mm). */
export function bodyCorners(s: Pick<DocState, 'rebuild'>): Vec3[] {
  const out: Vec3[] = [];
  for (const b of s.rebuild.bodies) {
    if (!b.visible) continue;
    const x = b.bbox;
    if (!x || x.length < 6 || !x.every(Number.isFinite)) continue;
    for (const px of [x[0], x[3]]) for (const py of [x[1], x[4]]) for (const pz of [x[2], x[5]]) out.push([px, py, pz]);
  }
  return out;
}

/** A plane's square: over the bodies' footprint on it and its own origin, 15 % wider; EMPTY_HALF around its origin with no body. */
export function planeSquare(frame: PlaneFrame, corners: readonly Vec3[]): DrawnPlane {
  const n = unit(frame.normal) ?? [0, 0, 1];
  const u = unit(frame.xdir) ?? [1, 0, 0];
  const v = unit(cross(n, u)) ?? [0, 1, 0];
  if (!corners.length) return { frame, center: frame.origin, u, v, half: EMPTY_HALF };
  let u0 = 0;
  let u1 = 0;
  let v0 = 0;
  let v1 = 0;
  for (const c of corners) {
    const d = sub(c, frame.origin);
    const du = dot(d, u);
    const dv = dot(d, v);
    u0 = Math.min(u0, du);
    u1 = Math.max(u1, du);
    v0 = Math.min(v0, dv);
    v1 = Math.max(v1, dv);
  }
  const half = Math.max((Math.max(u1 - u0, v1 - v0) / 2) * 1.15, 1e-3);
  const center = add(add(frame.origin, scale(u, (u0 + u1) / 2)), scale(v, (v0 + v1) / 2));
  return { frame, center, u, v, half };
}

/** An axis's segment: across the bodies (their corners projected on it) and its own point, 10 % longer each way. */
export function axisSegment(origin: Vec3, dir: Vec3, corners: readonly Vec3[]): { a: Vec3; b: Vec3; dir: Vec3 } {
  const d = unit(dir) ?? [0, 0, 1];
  let t0 = corners.length ? 0 : -EMPTY_HALF;
  let t1 = corners.length ? 0 : EMPTY_HALF;
  for (const c of corners) {
    const t = dot(sub(c, origin), d);
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  const pad = Math.max((t1 - t0) * 0.1, 1);
  return { a: add(origin, scale(d, t0 - pad)), b: add(origin, scale(d, t1 + pad)), dir: d };
}

/** What the viewport draws for CONSTRUCT features now. */
export function drawnConstructs(s: Pick<DocState, 'doc' | 'view' | 'rebuild'>, mode: Mode): DrawnConstruct[] {
  const corners = bodyCorners(s);
  const out: DrawnConstruct[] = [];
  for (const f of s.doc.features) {
    const kind = constructKindOfType(f.type);
    if (!kind || !constructShown(s.view, f.id)) continue;
    const o = constructOutput(s, f.id);
    if (!o) continue;
    if (o.type === 'plane') {
      if (mode === 'sketch') continue;
      out.push({ feature: f.id, name: f.name, kind, plane: planeSquare(o.frame, corners) });
    } else if (o.type === 'axis') out.push({ feature: f.id, name: f.name, kind, axis: axisSegment(o.origin, o.dir, corners) });
    else out.push({ feature: f.id, name: f.name, kind, point: [...o.p] as Vec3 });
  }
  return out;
}
