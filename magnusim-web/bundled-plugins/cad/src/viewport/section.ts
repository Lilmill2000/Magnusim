// Section view: one clipping plane parallel to a plane (an origin plane, a construction plane or a
// flat face: SectionState.frame, found by src/features/section), and a cap where
// it cuts through material (stencil parity: back faces +1, front faces -1; the
// cap draws where the count is not 0). The cap is shaded like a body face and
// hatched, so a cut never reads as an ordinary face. The count keeps to the
// stencil's low bits (onface.ts PARITY_MASK); in a dark view the cap, a light
// surface, sets the bit the marks over it read (onface.ts FACE_BIT, E2).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  AlwaysStencilFunc,
  BackSide,
  BufferAttribute,
  DecrementWrapStencilOp,
  FrontSide,
  Group,
  IncrementWrapStencilOp,
  KeepStencilOp,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NotEqualStencilFunc,
  Plane,
  PlaneGeometry,
  ReplaceStencilOp,
  Vector3,
  type BufferGeometry,
  type Sphere,
} from 'three';
import { ORIGIN_PLANES, type OriginPlaneRef, type PlaneFrame, type Vec3 } from '../types/doc';
import type { SectionState, ViewportHandle } from '../types/viewport';
import { BODY_COLOR } from './colors';
import { createBodyMaterial, SEE_THROUGH_OPACITY, type BodyMaterial } from './materials';
import { FACE_BIT, PARITY_MASK } from './onface';

/** An origin plane's frame (a copy). */
export function originFrame(plane: OriginPlaneRef): PlaneFrame {
  const p = ORIGIN_PLANES[plane];
  return { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 };
}

export const DEFAULT_SECTION: SectionState = { on: false, plane: { kind: 'origin', plane: 'origin:front' }, frame: originFrame('origin:front'), offset: 0, flip: false };

/** A round slider step (1, 2 or 5 times a power of ten) giving about 400 stops over `span`. */
export function sliderStep(span: number): number {
  const raw = Math.max(span / 400, 1e-4);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw - 1e-12) ?? raw;
}

/** Where a new cut starts: the middle of the part, on a round step ("Y 10 mm", not "Y 5.008 mm"). */
export function sectionStart(range: readonly [number, number] | null): number {
  if (!range) return 0;
  const step = sliderStep(Math.abs(range[1] - range[0]));
  const mid = (range[0] + range[1]) / 2;
  return Math.round(mid / step) * step || 0;
}

/**
 * Where a cut that comes on starts: at a construction plane itself (the plane was made to cut there),
 * else through the middle of the shown bodies on a round step (an origin plane, a flat face). The
 * view tools' button and INSPECT > Section view both turn it on so.
 */
export function startOffset(h: Pick<ViewportHandle, 'sectionRange'>, s: Pick<SectionState, 'plane' | 'frame'>): number {
  return s.plane.kind === 'feature' ? 0 : sectionStart(h.sectionRange(s.frame));
}

/** A frame that can carry a cut: finite, with a normal that is not zero. */
export function usableFrame(f: Pick<PlaneFrame, 'origin' | 'normal'> | null | undefined): boolean {
  return !!f && f.origin.length === 3 && f.normal.length === 3 && [...f.origin, ...f.normal].every(Number.isFinite) && Math.hypot(...f.normal) > 1e-12;
}

/**
 * The section state after a change (ViewportHandle.setSection): a new origin plane brings its own
 * frame; any other plane needs the frame found for it in the same change, else it throws (the
 * section module finds it). An unusable frame or offset keeps what was.
 */
export function nextSection(cur: SectionState, patch: Partial<SectionState>): SectionState {
  const next = { ...cur, ...patch };
  if (!Number.isFinite(next.offset)) next.offset = Number.isFinite(cur.offset) ? cur.offset : 0;
  if (patch.plane) {
    if (patch.plane.kind === 'origin') {
      if (!(patch.plane.plane in ORIGIN_PLANES)) next.plane = { kind: 'origin', plane: 'origin:front' };
      if (!patch.frame) next.frame = originFrame((next.plane as { plane: OriginPlaneRef }).plane);
    } else if (!patch.frame) throw new Error('setSection: a construction plane or a face needs its frame');
  }
  if (!usableFrame(next.frame)) next.frame = cur.frame;
  next.frame = { origin: [...next.frame.origin] as Vec3, normal: [...next.frame.normal] as Vec3, xdir: [...(next.frame.xdir ?? [1, 0, 0])] as Vec3 };
  return next;
}

/** The clipping plane for a section (three keeps points with normal . p + constant >= 0). */
export function sectionPlane(s: Pick<SectionState, 'offset' | 'flip'> & { frame: Pick<PlaneFrame, 'origin' | 'normal'> }, out = new Plane()): Plane {
  const n = new Vector3(...s.frame.normal).normalize();
  // Keep the side behind the plane (away from its normal) unless flipped: the
  // cut face then looks towards the viewer of that plane's standard view.
  const keep = s.flip ? n : n.clone().negate();
  // Points p with keep . p + c >= 0, the plane through origin + offset * n.
  const at = new Vector3(...s.frame.origin).addScaledVector(n, s.offset);
  return out.set(keep, -keep.dot(at));
}

/**
 * The offsets along a frame's normal (from its origin) that a box spans ([xmin, ymin, zmin, xmax,
 * ymax, zmax] each), or null without one: the section's range, and its middle.
 */
export function offsetRange(frame: Pick<PlaneFrame, 'origin' | 'normal'>, boxes: readonly (readonly number[])[]): [number, number] | null {
  const l = Math.hypot(...frame.normal);
  if (!(l > 0)) return null;
  const n = frame.normal.map((v) => v / l);
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of boxes) {
    if (b.length < 6 || !b.slice(0, 6).every(Number.isFinite)) continue;
    for (const x of [b[0], b[3]])
      for (const y of [b[1], b[4]])
        for (const z of [b[2], b[5]]) {
          const d = n[0] * (x - frame.origin[0]) + n[1] * (y - frame.origin[1]) + n[2] * (z - frame.origin[2]);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * The caps of the cut. Two of them in the view: the opaque bodies' (drawn first, before every body,
 * writing depth), and the see-through bodies' (`seeThrough`: drawn in three's transparent pass, after
 * every opaque surface and before the see-through bodies, at their opacity, writing no depth), so an
 * opaque body inside or behind a see-through one keeps its own cap and shows through the other's
 * (an Enclosure's air, a body the person made see-through). Each counts its own bodies: the opaque
 * cap leaves the count at 0 wherever it drew, and the see-through one counts again from there and
 * clears it as it draws or is hidden. A see-through cap never touches FACE_BIT (onface.ts), as a
 * see-through body does not.
 */
export class SectionCaps {
  readonly group = new Group();
  private readonly capMat: BodyMaterial;
  private readonly cap: Mesh;
  private stencils = new Map<string, Mesh[]>();
  private readonly seeThrough: boolean;

  constructor(pixelRatio = 1, opts: { seeThrough?: boolean } = {}) {
    this.seeThrough = !!opts.seeThrough;
    this.group.name = this.seeThrough ? 'section-caps-see-through' : 'section-caps';
    this.group.visible = false;
    this.capMat = createBodyMaterial(BODY_COLOR, undefined, { hatchPixelRatio: pixelRatio });
    this.capMat.polygonOffset = false;
    // Where the count (the low bits) is not 0; drawn, it clears the count (and, dark, sets FACE_BIT).
    this.capMat.stencilWrite = true;
    this.capMat.stencilFunc = NotEqualStencilFunc;
    this.capMat.stencilFuncMask = PARITY_MASK;
    this.capMat.stencilFail = KeepStencilOp;
    this.capMat.stencilZPass = ReplaceStencilOp;
    if (this.seeThrough) {
      // Translucent as the see-through bodies, no depth (what is behind shows); the count only.
      this.capMat.transparent = true;
      this.capMat.depthWrite = false;
      this.capMat.uniforms.uOpacity.value = SEE_THROUGH_OPACITY;
      this.capMat.stencilWriteMask = PARITY_MASK;
      this.capMat.stencilRef = 0;
      this.capMat.stencilZFail = ReplaceStencilOp;
    }
    this.setFaceBit(false);
    const g = new PlaneGeometry(2, 2);
    g.setAttribute('hl', new BufferAttribute(new Uint8Array(g.getAttribute('position').count), 1));
    this.cap = new Mesh(g, this.capMat);
    this.cap.matrixAutoUpdate = false;
    this.cap.renderOrder = -1;
    this.cap.name = this.seeThrough ? 'section-cap-see-through' : 'section-cap';
    this.group.add(this.cap);
  }

  /**
   * E2 (onface.ts): in a dark view the cap sets FACE_BIT where it shows (a light surface; where it
   * is hidden it leaves the stencil); in light it writes 0 as it always did.
   */
  setFaceBit(on: boolean): void {
    // A see-through cap shows what is behind it: never a light surface of its own.
    if (this.seeThrough) return;
    this.capMat.stencilRef = on ? FACE_BIT : 0;
    this.capMat.stencilZFail = on ? KeepStencilOp : ReplaceStencilOp;
  }

  /** Keep one pair of stencil meshes per body geometry (by key). */
  setBodies(bodies: { key: string; geometry: BufferGeometry; visible: boolean }[], plane: Plane): void {
    const keep = new Set(bodies.map((b) => b.key));
    for (const [key, meshes] of this.stencils) {
      if (keep.has(key)) continue;
      for (const m of meshes) {
        this.group.remove(m);
        (m.material as MeshBasicMaterial).dispose();
      }
      this.stencils.delete(key);
    }
    for (const b of bodies) {
      let meshes = this.stencils.get(b.key);
      if (!meshes) {
        meshes = [this.stencilMesh(b.geometry, BackSide, IncrementWrapStencilOp), this.stencilMesh(b.geometry, FrontSide, DecrementWrapStencilOp)];
        this.stencils.set(b.key, meshes);
        this.group.add(...meshes);
      }
      for (const m of meshes) {
        m.visible = b.visible;
        (m.material as MeshBasicMaterial).clippingPlanes = [plane];
      }
    }
  }

  private stencilMesh(geometry: BufferGeometry, side: typeof FrontSide | typeof BackSide, op: typeof IncrementWrapStencilOp | typeof DecrementWrapStencilOp): Mesh {
    const mat = new MeshBasicMaterial({
      side,
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      // The see-through caps' count in the transparent pass, with their cap (after every opaque surface).
      transparent: this.seeThrough,
      stencilWrite: true,
      // The count only: FACE_BIT is the bodies' and the cap's.
      stencilWriteMask: PARITY_MASK,
      stencilFunc: AlwaysStencilFunc,
      stencilFail: op,
      stencilZFail: op,
      stencilZPass: op,
    });
    const m = new Mesh(geometry, mat);
    m.renderOrder = -2;
    m.name = this.seeThrough ? 'section-stencil-see-through' : 'section-stencil';
    return m;
  }

  /** Place the cap square in the plane, big enough for the scene. */
  place(plane: Plane, scene: Sphere, color: number): void {
    const n = plane.normal.clone();
    const origin = plane.coplanarPoint(new Vector3());
    // Project the scene centre onto the plane so the square covers everything.
    const c = scene.center.clone().sub(n.clone().multiplyScalar(plane.distanceToPoint(scene.center)));
    const u = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1).cross(n).normalize() : new Vector3(1, 0, 0).cross(n).normalize();
    const v = new Vector3().crossVectors(n, u).normalize();
    const half = Math.max(scene.radius * 1.5, 1e-3);
    const m = new Matrix4().makeBasis(u.multiplyScalar(half), v.multiplyScalar(half), n.clone().multiplyScalar(half));
    m.setPosition(c.lengthSq() > 0 ? c : origin);
    this.cap.matrix.copy(m);
    this.cap.matrixWorldNeedsUpdate = true;
    this.capMat.uniforms.uColor.value.set(((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255);
  }

  dispose(): void {
    for (const meshes of this.stencils.values()) for (const m of meshes) (m.material as MeshBasicMaterial).dispose();
    this.stencils.clear();
    this.cap.geometry.dispose();
    this.capMat.dispose();
  }
}
