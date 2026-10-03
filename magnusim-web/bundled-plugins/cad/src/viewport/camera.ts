// The camera model, matching the core's vtk.js camera and manipulators
// (runtime.js:1051-1066 wires vtkMouseCameraTrackball{Rotate,Pan,Zoom}Manipulator):
// a position, a focal point and a view-up, rotated about a separate pivot (the
// model's centroid, runtime.js:9214-9310). Pure math over three's Vector3: the
// renderer-side cameras are updated from it (apply()).
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Sphere, Vector3 } from 'three';
import type { Vec3 } from '../types/doc';
import type { Projection, StandardView } from '../types/viewport';
import { FOV_DEG, HOME_DIR } from './colors';

/** Camera direction (from the target towards the camera) and screen-up for each standard view. Z is up; Front looks along +Y. */
export const VIEW_DIRS: Record<StandardView, { dir: Vec3; up: Vec3 }> = {
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  // Top: the front of the part at the bottom of the screen; Bottom: at the top (SOLIDWORKS).
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  iso: { dir: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], up: [0, 0, 1] },
  home: { dir: HOME_DIR, up: [0, 0, 1] },
};

export interface CameraPose {
  position: Vector3;
  target: Vector3;
  up: Vector3;
  /** Orthographic: visible height at the target (world units). */
  orthoHeight: number;
  /**
   * CSS px the image's centre (where the target is drawn) sits right of the view's centre, so a
   * framed part is centred beside the panels over the left of the view (frameBeside). Kept until
   * the next framing; absent = unchanged.
   */
  shift?: number;
}

const _m = new Matrix4();
const _m2 = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();

export class CameraRig {
  position = new Vector3(0, -200, 0);
  target = new Vector3(0, 0, 0);
  up = new Vector3(0, 0, 1);
  /** The orbit centre (vtk style centerOfRotation). */
  pivot = new Vector3(0, 0, 0);
  fov = FOV_DEG;
  projection: Projection = 'perspective';
  /** Visible height at the target in orthographic projection. */
  orthoHeight = 100;
  /** CSS px the target is drawn right of the view's centre (see CameraPose.shift). */
  shift = 0;
  /** Bounding sphere of everything drawn (near/far planes). */
  scene = new Sphere(new Vector3(), 50);

  constructor(readonly persp = new PerspectiveCamera(FOV_DEG, 1, 0.1, 1000), readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)) {}

  get distance(): number {
    return this.position.distanceTo(this.target);
  }

  /** Unit vector from the camera to the target (vtk "direction of projection"). */
  dop(out = new Vector3()): Vector3 {
    return out.subVectors(this.target, this.position).normalize();
  }

  /** Screen-right in world space. */
  right(out = new Vector3()): Vector3 {
    return out.crossVectors(this.dop(_v2), this.up).normalize();
  }

  pose(): CameraPose {
    return { position: this.position.clone(), target: this.target.clone(), up: this.up.clone(), orthoHeight: this.orthoHeight, shift: this.shift };
  }

  setPose(p: CameraPose): void {
    this.position.copy(p.position);
    this.target.copy(p.target);
    this.up.copy(p.up);
    this.orthoHeight = p.orthoHeight;
    if (p.shift != null) this.shift = p.shift;
    this.orthogonalizeUp();
  }

  orthogonalizeUp(): void {
    const d = this.dop(_v);
    this.up.addScaledVector(d, -this.up.dot(d));
    if (this.up.lengthSq() < 1e-12) this.up.set(0, 0, 1).addScaledVector(d, -d.z);
    if (this.up.lengthSq() < 1e-12) this.up.set(0, 1, 0);
    this.up.normalize();
  }

  /** Height of the view at the target (world units), in either projection. */
  viewHeightAtTarget(): number {
    return this.projection === 'orthographic' ? this.orthoHeight : 2 * this.distance * Math.tan((this.fov * Math.PI) / 360);
  }

  /** World units per CSS pixel at a point (for pick tolerances and markers). */
  worldPerPixel(p: Vector3, viewportHeightPx: number): number {
    if (this.projection === 'orthographic') return this.orthoHeight / Math.max(1, viewportHeightPx);
    const depth = Math.max(1e-9, _v.subVectors(p, this.position).dot(this.dop(_v2)));
    return (2 * depth * Math.tan((this.fov * Math.PI) / 360)) / Math.max(1, viewportHeightPx);
  }

  /**
   * Trackball rotate (vtkMouseCameraTrackballRotateManipulator): a drag across
   * the whole width turns 360 deg about the view-up through the pivot, one
   * across the whole height 360 deg about screen-right. dx/dy in CSS px, y down.
   */
  orbit(dxPx: number, dyPx: number, widthPx: number, heightPx: number): void {
    // vtk: dx = prev.x - pos.x, dy = prev.y - pos.y with y up; so -dx and +dy (y down) here.
    const az = (((360 * -dxPx) / Math.max(1, widthPx)) * Math.PI) / 180;
    const el = (((-360 * dyPx) / Math.max(1, heightPx)) * Math.PI) / 180;
    const up = this.up.clone();
    const axis2 = _v.crossVectors(this.dop(_v2), up).normalize();
    // trans = T(c) * R(up, az) * R(axis2, el) * T(-c)
    _m.makeTranslation(this.pivot.x, this.pivot.y, this.pivot.z);
    _m.multiply(_m2.makeRotationAxis(up, az));
    _m.multiply(_m2.makeRotationAxis(axis2, el));
    _m.multiply(_m2.makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z));
    const upTip = _v2.copy(this.position).add(this.up).applyMatrix4(_m);
    this.position.applyMatrix4(_m);
    this.target.applyMatrix4(_m);
    this.up.subVectors(upTip, this.position);
    this.orthogonalizeUp();
  }

  /**
   * Pan (vtkMouseCameraTrackballPanManipulator): the point at the pivot's depth
   * under the pointer follows the pointer. dx/dy in CSS px, y down.
   */
  pan(dxPx: number, dyPx: number, heightPx: number): void {
    const wpp = this.worldPerPixel(this.pivot, heightPx);
    const right = this.right(_v);
    const shift = _v2.copy(right).multiplyScalar(-dxPx * wpp).addScaledVector(this.up, dyPx * wpp);
    this.position.add(shift);
    this.target.add(shift);
  }

  /**
   * Zoom by `factor` (> 1 zooms in) keeping `anchor` fixed on screen (zoom to
   * cursor). Perspective: camera and target scale towards the anchor.
   * Orthographic: the view height shrinks and the target moves towards the anchor.
   */
  zoomAt(factor: number, anchor: Vector3 | null): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const a = anchor ?? this.target;
    if (this.projection === 'orthographic') {
      const d = this.dop(_v);
      // Move the target within the view plane only.
      const shift = _v2.subVectors(a, this.target);
      shift.addScaledVector(d, -shift.dot(d));
      shift.multiplyScalar(1 - 1 / factor);
      this.target.add(shift);
      this.position.add(shift);
      this.orthoHeight /= factor;
      return;
    }
    this.position.sub(a).multiplyScalar(1 / factor).add(a);
    this.target.sub(a).multiplyScalar(1 / factor).add(a);
  }

  /** Frame a sphere along the current direction (vtk resetCamera: distance r / sin(fov/2)). */
  frame(sphere: Sphere): void {
    const r = Math.max(sphere.radius, 1e-6);
    const d = this.dop(_v).negate();
    const dist = r / Math.sin((this.fov * Math.PI) / 360);
    this.target.copy(sphere.center);
    this.position.copy(sphere.center).addScaledVector(d, dist);
    this.orthoHeight = 2 * r;
    this.shift = 0;
  }

  /**
   * After frame(): keep the framed sphere clear of a column `coverPx` wide that
   * floats over the left of a `widthPx` x `heightPx` view (the tree and the open
   * panel). The view widens when the free part is narrower than it is tall, and
   * the camera moves so the sphere's centre sits in the middle of the free part.
   */
  frameBeside(widthPx: number, heightPx: number, coverPx: number): void {
    this.shift = 0;
    if (!(coverPx > 0) || !(widthPx > coverPx) || !(heightPx > 0)) return;
    const k = heightPx / (widthPx - coverPx);
    if (k > 1) {
      this.orthoHeight *= k;
      this.position.sub(this.target).multiplyScalar(k).add(this.target);
    }
    // The image's centre moves, not the camera: the part is still seen straight on (in
    // perspective a camera moved sideways looked at it from the side).
    this.shift = coverPx / 2;
  }

  /** Point the camera along a direction (from the target to the camera) with an up hint, keeping the target and distance. */
  orient(dir: Vec3, upHint: Vec3): void {
    const d = new Vector3(...dir).normalize();
    const dist = this.distance || 100;
    this.position.copy(this.target).addScaledVector(d, dist);
    this.up.set(...upHint);
    if (Math.abs(this.up.clone().normalize().dot(d)) > 0.999) this.up.set(0, 1, 0);
    this.orthogonalizeUp();
  }

  /** The camera orientation as a quaternion (three's convention: looks down -Z, up +Y). */
  quaternion(out = new Quaternion()): Quaternion {
    _m.lookAt(this.position, this.target, this.up);
    return out.setFromRotationMatrix(_m);
  }

  /** Interpolate between two poses (slerp the orientation, blend target, distance and ortho height). */
  static blend(a: CameraPose, b: CameraPose, t: number): CameraPose {
    const qa = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(a.position, a.target, a.up));
    const qb = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(b.position, b.target, b.up));
    const q = _q.copy(qa).slerp(qb, t);
    const target = a.target.clone().lerp(b.target, t);
    const da = a.position.distanceTo(a.target);
    const db = b.position.distanceTo(b.target);
    const dist = Math.exp(Math.log(Math.max(da, 1e-9)) * (1 - t) + Math.log(Math.max(db, 1e-9)) * t);
    const back = new Vector3(0, 0, 1).applyQuaternion(q);
    const up = new Vector3(0, 1, 0).applyQuaternion(q);
    const position = target.clone().addScaledVector(back, dist);
    const orthoHeight = Math.exp(Math.log(Math.max(a.orthoHeight, 1e-9)) * (1 - t) + Math.log(Math.max(b.orthoHeight, 1e-9)) * t);
    const shift = (a.shift ?? 0) * (1 - t) + (b.shift ?? 0) * t;
    return { position, target, up, orthoHeight, shift };
  }

  /** Switch projection keeping the apparent size at the target. */
  setProjection(p: Projection): void {
    if (p === this.projection) return;
    if (p === 'orthographic') this.orthoHeight = 2 * this.distance * Math.tan((this.fov * Math.PI) / 360);
    else {
      // Keep the size: move the camera so the perspective view height matches.
      const dist = this.orthoHeight / (2 * Math.tan((this.fov * Math.PI) / 360));
      const back = this.dop(_v).negate();
      this.position.copy(this.target).addScaledVector(back, dist);
    }
    this.projection = p;
  }

  /**
   * Update three's cameras (near/far from the scene sphere) and return the active one.
   * `widthPx`: the view's width, for the image's shift (none without it).
   */
  apply(aspect: number, widthPx = 0): PerspectiveCamera | OrthographicCamera {
    const cam = this.applyCamera(aspect);
    const w = widthPx;
    const h = w / aspect;
    if (this.shift && w > 0 && h > 0) cam.setViewOffset(w, h, -this.shift, 0, w, h);
    else if (cam.view) cam.clearViewOffset();
    return cam;
  }

  private applyCamera(aspect: number): PerspectiveCamera | OrthographicCamera {
    const dop = this.dop(_v);
    const depthC = _v2.subVectors(this.scene.center, this.position).dot(dop);
    const R = Math.max(this.scene.radius, 1e-3) * 1.05;
    if (this.projection === 'perspective') {
      const cam = this.persp;
      cam.fov = this.fov;
      cam.aspect = aspect;
      const far = Math.max(depthC + R, 1e-3);
      cam.near = Math.max(depthC - R, far * 1e-5, 1e-4);
      cam.far = far;
      cam.position.copy(this.position);
      cam.up.copy(this.up);
      cam.lookAt(this.target);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      return cam;
    }
    const cam = this.ortho;
    const h = this.orthoHeight / 2;
    cam.left = -h * aspect;
    cam.right = h * aspect;
    cam.top = h;
    cam.bottom = -h;
    cam.near = depthC - R - 1;
    cam.far = depthC + R + 1;
    cam.position.copy(this.position);
    cam.up.copy(this.up);
    cam.lookAt(this.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }
}
