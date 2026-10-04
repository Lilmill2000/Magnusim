import { describe, expect, it } from 'vitest';
import { CAMERA_DRAG_PX, cameraMovedSince, isCameraDrag, sameCameraView, type CameraSnap } from './landingCamera';

const cam = (over: Partial<CameraSnap> = {}): CameraSnap => ({ pos: [400, 15, 15], fp: [0, 15, 15], vu: [0, 0, 1], parallel: true, scale: 50, ...over });

describe('the camera a landing finds moved by the user (Continue in background)', () => {
  it('a click with a few pixels of jitter is not a drag; a press moved further with a button held is', () => {
    const press = { x: 100, y: 100 };
    expect(isCameraDrag(press, 102, 101, 1)).toBe(false);
    expect(isCameraDrag(press, 100 + CAMERA_DRAG_PX, 100, 1)).toBe(false);
    expect(isCameraDrag(press, 100 + CAMERA_DRAG_PX + 1, 100, 1)).toBe(true);
    expect(isCameraDrag(press, 140, 150, 2)).toBe(true);
    // No button held (a hover), or no press in the viewport: never a drag.
    expect(isCameraDrag(press, 140, 150, 0)).toBe(false);
    expect(isCameraDrag(null, 140, 150, 1)).toBe(false);
  });

  it('the same view is the same within a millionth; position, target, up, projection and scale each count', () => {
    expect(sameCameraView(cam(), cam({ pos: [400 + 1e-5, 15, 15] }))).toBe(true);
    expect(sameCameraView(cam(), cam({ pos: [401, 15, 15] }))).toBe(false);
    expect(sameCameraView(cam(), cam({ fp: [0, 16, 15] }))).toBe(false);
    expect(sameCameraView(cam(), cam({ vu: [0, 1, 0] }))).toBe(false);
    expect(sameCameraView(cam(), cam({ parallel: false }))).toBe(false);
    expect(sameCameraView(cam(), cam({ scale: 60 }))).toBe(false);
    expect(sameCameraView(null, null)).toBe(true);
    expect(sameCameraView(cam(), null)).toBe(false);
  });

  it('moved only when the user dragged or wheeled after the landing began and the view differs', () => {
    const since = { cam: cam(), at: 1000 };
    const orbited = cam({ pos: [380, 120, 40] });
    expect(cameraMovedSince(since, 1500, orbited)).toBe(true);
    // Input before the landing began is not this landing's.
    expect(cameraMovedSince(since, 900, orbited)).toBe(false);
    // No input at all: a camera that changed was moved by a framing, not by the user.
    expect(cameraMovedSince(since, 0, orbited)).toBe(false);
    // Input, but the view is the one the landing began with (a drag that moved no camera).
    expect(cameraMovedSince(since, 1500, cam())).toBe(false);
    expect(cameraMovedSince(null, 1500, orbited)).toBe(false);
    expect(cameraMovedSince(undefined, 1500, orbited)).toBe(false);
  });
});
