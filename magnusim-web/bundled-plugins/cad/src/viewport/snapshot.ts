// ViewportHandle.snapshot's pure parts: the eight directions (the standard views but Home, and iso
// from back-left-top), the picture's own orthographic camera framing what it shows, its size, its
// cut, the triad's corner, the overlay layers a picture leaves out, and the render target's rows
// read top to bottom. The drawing itself is snapshot() in viewport.ts, beside measure(): one task,
// no animation frame, and the person's camera, framing, section view and highlight put back.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Plane, Vector3, type Camera, type Sphere } from 'three';
import type { Vec3 } from '../types/doc';
import type { Projection, SnapshotOptions, SnapshotView } from '../types/viewport';
import { CameraRig, VIEW_DIRS } from './camera';
import { TRIAD_PX } from './colors';
import { originFrame, sectionPlane, usableFrame } from './section';


/** Camera direction (from the part towards the camera) and screen-up of each snapshot view. */
export const SNAPSHOT_DIRS: Record<SnapshotView, { dir: Vec3; up: Vec3 }> = {
  front: VIEW_DIRS.front,
  back: VIEW_DIRS.back,
  left: VIEW_DIRS.left,
  right: VIEW_DIRS.right,
  top: VIEW_DIRS.top,
  bottom: VIEW_DIRS.bottom,
  iso: VIEW_DIRS.iso,
  // Iso seen from back-left-top: `iso` (front-right-top) turned half a turn about Z.
  iso_back: VIEW_DIRS.iso_back,
};

/** The largest side of a picture (px), also never more than the GPU's largest texture. */
export const SNAPSHOT_MAX_PX = 4096;

/** The picture's size in whole pixels; a RangeError in words when it is not 1 to the largest side. */
export function snapshotSize(o: Pick<SnapshotOptions, 'width' | 'height'>, gpuMaxPx = SNAPSHOT_MAX_PX): { width: number; height: number } {
  const max = Math.max(1, Math.min(SNAPSHOT_MAX_PX, gpuMaxPx || SNAPSHOT_MAX_PX));
  const width = Math.round(o.width);
  const height = Math.round(o.height);
  if (!(width >= 1 && height >= 1 && width <= max && height <= max)) throw new RangeError(`A snapshot is 1 to ${max} px on each side, not ${o.width} x ${o.height}`);
  return { width, height };
}

/**
 * The picture's camera: orthographic, looking along the view's direction (or `view` itself: a
 * direction from the part towards the camera and the picture's up) at the sphere's centre,
 * the sphere filling the picture's height, or its width when the picture is taller than wide.
 * `sphere` already carries the framing margin. The caller sets `scene` (near and far) to all that
 * is drawn.
 */
export function snapshotRig(view: SnapshotView | { dir: Vec3; up: Vec3 }, sphere: Sphere, width: number, height: number, projection: Projection = 'orthographic'): CameraRig {
  const d = typeof view === 'string' ? SNAPSHOT_DIRS[view] : view;
  const rig = new CameraRig();
  rig.projection = 'orthographic';
  rig.orient(d.dir, d.up);
  rig.frame(sphere);
  if (width < height) rig.orthoHeight *= height / width;
  // Perspective (the Assistant's pictures may ask for it): the same apparent size at the centre.
  if (projection === 'perspective') rig.setProjection('perspective');
  rig.scene.copy(sphere);
  return rig;
}

/** A model point in a picture drawn with `camera` (px from the top left), or null outside its depth. */
export function projectToPicture(camera: Camera, width: number, height: number, p: Vec3): [number, number] | null {
  const v = new Vector3(p[0], p[1], p[2]).project(camera);
  if (!(v.z >= -1 && v.z <= 1)) return null;
  return [((v.x + 1) / 2) * width, ((1 - v.y) / 2) * height];
}

/** A snapshot's cut as the section view cuts: a frame (an origin plane's own), its offset and side (the view's own section state is never written). */
export function snapshotSection(s: NonNullable<SnapshotOptions['section']>): { frame: { origin: Vec3; normal: Vec3 }; offset: number; flip: boolean } {
  const offset = Number.isFinite(s.offset) ? s.offset : 0;
  const f = 'plane' in s ? originFrame(`origin:${s.plane}`) : usableFrame(s.frame) ? s.frame : originFrame('origin:front');
  return { frame: { origin: [...f.origin] as Vec3, normal: [...f.normal] as Vec3 }, offset, flip: !!s.flip };
}

/** The clipping plane of a snapshot's cut (kept side: distanceToPoint >= 0), as the section view makes it. */
export function snapshotClip(s: NonNullable<SnapshotOptions['section']>): Plane {
  return sectionPlane(snapshotSection(s), new Plane());
}

/**
 * Where the triad goes in a picture: the bottom-right corner, in render-target pixels (origin
 * bottom-left), as large as the view's (TRIAD_PX) or a fifth of the shorter side; null when the
 * picture is too small for one.
 */
export function snapshotTriadRect(width: number, height: number): { x: number; y: number; s: number } | null {
  const s = Math.round(Math.min(TRIAD_PX, Math.min(width, height) * 0.2));
  if (s < 24) return null;
  const m = Math.max(2, Math.round(s / 8));
  return { x: width - s - m, y: m, s };
}

/** A render target's pixels (rows bottom to top) as a picture's rows top to bottom. */
export function rowsTopDown(src: Uint8Array, width: number, height: number): Uint8ClampedArray {
  const row = width * 4;
  const out = new Uint8ClampedArray(row * height);
  for (let y = 0; y < height; y++) out.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return out;
}

/**
 * Overlay layers a picture leaves out: the manipulators and markers (the Extrude's arrow, the
 * Enclosure's handles, Move/copy body's handle, the section view's arrow, Measure's markers, the pattern markers, the solids' pick marks, sketch
 * mode's plane picker) and the bananas for scale. The sketches and the reference planes stay.
 * tests/viewport/snapshot.test.ts pins each id against its owner's.
 */
export const SNAPSHOT_HIDDEN_LAYERS: ReadonlySet<string> = new Set([
  'extrude.handle',
  'enclosure.handles',
  'move_body.handle',
  'section.arrow',
  'p2-measure',
  'pattern.markers',
  'solids.picks',
  'sketch.pick',
  'scale-banana',
  'scale-sketch-banana',
]);

/** What snapshot throws when it cannot draw (the WebGL context is lost, or the view is gone). */
export function notReady(): Error & { code: 'not_ready' } {
  return Object.assign(new Error('not_ready'), { code: 'not_ready' as const });
}
