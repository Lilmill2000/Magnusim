// What a spline needs before a relation takes its curve (P4b): a fit spline's
// tangent handle at an end (Tangent there goes through it).
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import type { SketchBuilder } from '../edit';
import { entityOf } from '../model';

/** Give a fit spline a tangent handle at one end (a new point at `at`). */
export function addHandle(b: SketchBuilder, h: { spline: string; end: 0 | 1; at: Vec2 }): void {
  const e = entityOf(b, h.spline);
  if (e?.kind !== 'spline' || e.form !== 'fit') return;
  const id = b.addPoint(h.at);
  const handles: [string | null, string | null] = [e.handles?.[0] ?? null, e.handles?.[1] ?? null];
  handles[h.end] = id;
  b.replaceEntity({ ...e, handles });
}
