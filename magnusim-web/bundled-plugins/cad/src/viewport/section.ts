// Section view: one clipping plane parallel to an origin plane, and a cap where
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
import { ORIGIN_PLANES } from '../types/doc';
import type { SectionState } from '../types/viewport';
import { BODY_COLOR } from './colors';
import { createBodyMaterial, type BodyMaterial } from './materials';
import { FACE_BIT, PARITY_MASK } from './onface';

export const DEFAULT_SECTION: SectionState = { on: false, plane: 'origin:front', offset: 0, flip: false };

/** The clipping plane for a section state (three keeps points with normal . p + constant >= 0). */
export function sectionPlane(s: SectionState, out = new Plane()): Plane {
  const n = new Vector3(...ORIGIN_PLANES[s.plane].normal).normalize();
  // Keep the side behind the plane (away from its normal) unless flipped: the
  // cut face then looks towards the viewer of that plane's standard view.
  const keep = s.flip ? n : n.clone().negate();
  // Points p with keep . p + c >= 0, the plane through offset * n.
  return out.set(keep, -keep.dot(n.clone().multiplyScalar(s.offset)));
}

export class SectionCaps {
  readonly group = new Group();
  private readonly capMat: BodyMaterial;
  private readonly cap: Mesh;
  private stencils = new Map<string, Mesh[]>();

  constructor(pixelRatio = 1) {
    this.group.name = 'section-caps';
    this.group.visible = false;
    this.capMat = createBodyMaterial(BODY_COLOR, undefined, { hatchPixelRatio: pixelRatio });
    this.capMat.polygonOffset = false;
    // Where the count (the low bits) is not 0; drawn, it clears the count (and, dark, sets FACE_BIT).
    this.capMat.stencilWrite = true;
    this.capMat.stencilFunc = NotEqualStencilFunc;
    this.capMat.stencilFuncMask = PARITY_MASK;
    this.capMat.stencilFail = KeepStencilOp;
    this.capMat.stencilZPass = ReplaceStencilOp;
    this.setFaceBit(false);
    const g = new PlaneGeometry(2, 2);
    g.setAttribute('hl', new BufferAttribute(new Uint8Array(g.getAttribute('position').count), 1));
    this.cap = new Mesh(g, this.capMat);
    this.cap.matrixAutoUpdate = false;
    this.cap.renderOrder = -1;
    this.cap.name = 'section-cap';
    this.group.add(this.cap);
  }

  /**
   * E2 (onface.ts): in a dark view the cap sets FACE_BIT where it shows (a light surface; where it
   * is hidden it leaves the stencil); in light it writes 0 as it always did.
   */
  setFaceBit(on: boolean): void {
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
    m.name = 'section-stencil';
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
