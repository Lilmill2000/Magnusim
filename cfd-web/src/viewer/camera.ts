export type Bounds = [number, number, number, number, number, number];

export interface RelativeCamera {
  dir: [number, number, number];
  up: number[];
  distRatio: number;
  fpOffset: [number, number, number];
}

type CameraLike = {
  getPosition: () => number[];
  getFocalPoint: () => number[];
  getViewUp: () => number[];
  setFocalPoint: (x: number, y: number, z: number) => void;
  setPosition: (x: number, y: number, z: number) => void;
  setViewUp: (x: number, y: number, z: number) => void;
};

type RendererLike = {
  getActiveCamera?: () => CameraLike | null;
};

function activeCamera(renderer?: RendererLike | null): CameraLike | null {
  const r = renderer || (window.__CFD_VIEW__?.renderer as RendererLike | undefined);
  return (r && r.getActiveCamera && r.getActiveCamera()) || null;
}

export function captureRelativeCamera(
  bounds: Bounds | number[] | null | undefined,
  renderer?: RendererLike | null,
): RelativeCamera | null {
  const cam = activeCamera(renderer);
  if (!cam || !bounds) return null;
  const span = Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
  if (!(span > 0)) return null;
  const pos = cam.getPosition();
  const fp = cam.getFocalPoint();
  const c = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2];
  const d = Math.hypot(pos[0] - fp[0], pos[1] - fp[1], pos[2] - fp[2]);
  if (!(d > 0)) return null;
  return {
    dir: [(pos[0] - fp[0]) / d, (pos[1] - fp[1]) / d, (pos[2] - fp[2]) / d],
    up: cam.getViewUp().slice(),
    distRatio: d / span,
    fpOffset: [(fp[0] - c[0]) / span, (fp[1] - c[1]) / span, (fp[2] - c[2]) / span],
  };
}

export function applyRelativeCamera(
  rel: RelativeCamera | null | undefined,
  bounds: Bounds | number[] | null | undefined,
  renderer?: RendererLike | null,
): boolean {
  const cam = activeCamera(renderer);
  if (!cam || !rel || !bounds) return false;
  const span = Math.max(bounds[1] - bounds[0], bounds[3] - bounds[2], bounds[5] - bounds[4]);
  if (!(span > 0)) return false;
  const c = [(bounds[0] + bounds[1]) / 2, (bounds[2] + bounds[3]) / 2, (bounds[4] + bounds[5]) / 2];
  const fp = [
    c[0] + rel.fpOffset[0] * span,
    c[1] + rel.fpOffset[1] * span,
    c[2] + rel.fpOffset[2] * span,
  ];
  const d = rel.distRatio * span;
  try {
    cam.setFocalPoint(fp[0], fp[1], fp[2]);
    cam.setPosition(fp[0] + rel.dir[0] * d, fp[1] + rel.dir[1] * d, fp[2] + rel.dir[2] * d);
    cam.setViewUp(rel.up[0], rel.up[1], rel.up[2]);
  } catch {
    return false;
  }
  return true;
}

export function meshDisplayScaleFromBounds(bounds: number[] | null | undefined): number {
  if (!bounds || bounds.length < 6) return 1;
  const dx = Math.abs(bounds[1] - bounds[0]);
  const dy = Math.abs(bounds[3] - bounds[2]);
  const dz = Math.abs(bounds[5] - bounds[4]);
  const span = Math.max(dx, dy, dz);
  if (!(span > 0)) return 1;
  // CAD is typically millimetres; results are metres.
  if (span > 20) return 0.001;
  return 1;
}

export function applyMeshDisplayScale(
  actor: { setScale?: (x: number, y: number, z: number) => void } | null | undefined,
  bounds: number[] | null | undefined,
): number {
  const s = meshDisplayScaleFromBounds(bounds);
  try {
    actor?.setScale?.(s, s, s);
  } catch {
    /* ignore */
  }
  return s;
}
