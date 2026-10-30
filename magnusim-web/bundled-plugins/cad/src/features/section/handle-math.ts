// The section view's arrow, its math (no three.js, no DOM; tests/features/section/section.test.ts):
//   Where      on the cut, where the line through the centre of the shown bodies' box along the
//              plane's normal crosses it (the cut's middle); with no body shown, the cut's point on
//              the plane's own normal line (cutPoint).
//   Which way  along the plane's own normal, whatever Flip keeps: the way Offset grows, so a drag
//              along the arrow always raises the field and the field's sign never surprises.
//   A drag     the offset it had plus how far the pointer went along the arrow (the point of its
//              line nearest the pointer's ray, as Move/copy body's arrows and the Extrude's),
//              rounded to what a pixel means at that zoom in the Part's display unit, or with Ctrl
//              held to whole steps (1 mm; 0.1 in, 0.01 ft), as Move/copy body's arrows.
// Owner: VIEWPORT (the section view's plane).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { PlaneFrame, Vec3 } from '../../types/doc';
import type { DocUnits } from '../../types/units';
import { lengthValue } from '../move_body/handle-math';
import { cutPoint } from './plane';

const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** The centre of the union of boxes ([xmin, ymin, zmin, xmax, ymax, zmax]), or null with none. */
function centreOf(boxes: readonly (readonly number[])[]): Vec3 | null {
  const ok = boxes.filter((b) => b.length >= 6 && b.slice(0, 6).every(Number.isFinite));
  if (!ok.length) return null;
  const c = [0, 1, 2].map((k) => (Math.min(...ok.map((b) => b[k])) + Math.max(...ok.map((b) => b[k + 3]))) / 2);
  return c as Vec3;
}

/** Where the arrow stands (on the cut) and which way it points (the plane's normal, unit). */
export function arrowPlace(frame: Pick<PlaneFrame, 'origin' | 'normal'>, offset: number, boxes: readonly (readonly number[])[]): { origin: Vec3; dir: Vec3 } {
  const n = unit(frame.normal);
  const at = cutPoint(frame, offset);
  const c = centreOf(boxes);
  if (!c) return { origin: at, dir: n };
  // The centre moved along the normal onto the cut.
  const d = n[0] * (c[0] - at[0]) + n[1] * (c[1] - at[1]) + n[2] * (c[2] - at[2]);
  return { origin: [c[0] - n[0] * d, c[1] - n[1] * d, c[2] - n[2] * d], dir: n };
}

/**
 * The offset a drag sets: `offset0` (when it was taken) plus `moved` mm along the arrow, rounded to a
 * pixel's step at that zoom (`pixelMm`) in the display unit, or with `snap` (Ctrl) to whole steps.
 */
export function draggedOffset(offset0: number, moved: number, pixelMm: number, units: DocUnits, snap: boolean): number {
  return lengthValue(offset0 + moved, pixelMm, units, snap).mm;
}
