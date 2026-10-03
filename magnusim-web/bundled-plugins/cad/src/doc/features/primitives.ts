// Size rules shared by the features that make solids (Extrude, Enclosure),
// and the origin axes' directions. P1's Box and Cylinder feature types lived
// here; they are removed (decision 2026-10-01: solids come only from sketches
// and STEP import; src/doc/features/removed.ts). The kernel keeps its `box`
// and `cylinder` ops: the Enclosure builds with them.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { OriginAxisRef, Vec3 } from '../../types/doc';

export const AXIS_DIR: Record<OriginAxisRef, Vec3> = { 'origin:x': [1, 0, 0], 'origin:y': [0, 1, 0], 'origin:z': [0, 0, 1] };

/**
 * The smallest size a solid takes (mm). Below it the kernel either refuses
 * (Standard_DomainError) or builds a solid it then calls invalid; the field
 * says so in plain words instead.
 */
export const MIN_SIZE_MM = 1e-6;
/** "Length must be at least 0.000001 mm" (the UI's field check says the same). */
export function sizeProblem(label: string, mm: number): string | null {
  if (!(mm > 0)) return `${label} must be more than 0`;
  if (mm < MIN_SIZE_MM) return `${label} must be at least 0.000001 mm`;
  return null;
}
