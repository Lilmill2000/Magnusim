/**
 * Whether the user moved the viewport's camera while a linked geometry's landing waited
 * (API 1.6, LINK 6.4 "Continue in background"): such a camera is theirs, and neither a
 * framing nor the page's view replaces it. A click (a face pick, a press on the empty
 * viewport, with the hand's few pixels of jitter) is not a move.
 */

/** The viewport camera as runtime.js snapshots it (model mm). */
export interface CameraSnap {
  pos: number[];
  fp: number[];
  vu: number[];
  parallel?: boolean;
  scale?: number | null;
}

/** A landing's start: the camera then, and when (ms). */
export interface LandingStart {
  cam: CameraSnap | null;
  at: number;
}

/** A press that moves this far (CSS px) with a button held is a drag of the camera, not a click. */
export const CAMERA_DRAG_PX = 4;

/** The pointer, pressed in the viewport at `press`, is now at (x, y) with `buttons` held: a drag of the camera. */
export function isCameraDrag(press: { x: number; y: number } | null, x: number, y: number, buttons: number): boolean {
  if (!press || !buttons) return false;
  return Math.hypot(x - press.x, y - press.y) > CAMERA_DRAG_PX;
}

/** Two camera snapshots show the same view (the user did not move it in between). */
export function sameCameraView(a: CameraSnap | null | undefined, b: CameraSnap | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const near = (x: number[], y: number[]) =>
    Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= 1e-6 * Math.max(1, Math.abs(v)));
  const sa = a.scale || 0;
  const sb = b.scale || 0;
  return near(a.pos, b.pos) && near(a.fp, b.fp) && near(a.vu, b.vu) && !!a.parallel === !!b.parallel && Math.abs(sa - sb) <= 1e-6 * Math.max(1, Math.abs(sa));
}

/**
 * The user moved the camera since `since`: they dragged or wheeled in the viewport after it
 * began (`inputAt`, ms), and the view now (`now`) differs from the one it began with.
 */
export function cameraMovedSince(since: LandingStart | null | undefined, inputAt: number, now: CameraSnap | null): boolean {
  if (!since || !(inputAt >= since.at)) return false;
  return !sameCameraView(since.cam, now);
}
