// Wall-clock limits per kernel op (a running wasm call cannot be interrupted:
// the watchdog terminates the worker). Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { KernelOp } from '../types/kernel-protocol';

export const DEFAULT_TIMEOUT_MS = 20_000;
/** Kernel start (download + compile + OCCT init); P0 measured 65–90 ms on localhost. */
export const BOOT_TIMEOUT_MS = 60_000;

/**
 * P0 (decision 6): slow ops on large parts get their own limits, and volume
 * properties and naming signatures run lazily. Imports of 100+ MB STEP took 28–37 s.
 */
export const OP_TIMEOUTS: Partial<Record<KernelOp, number>> = {
  import_step: 300_000,
  export_step: 120_000,
  props: 120_000,
  topo: 120_000,
  tessellate: 60_000,
  check: 60_000,
  // API 3 (docs/p2p3-plan.md §2). heal on the 113 MB part is part of the 28-37 s
  // import; BREP read / write scale with the file; measure on a large body runs
  // BRepExtrema over every face. Modelling ops on large inputs also get
  // LARGE_OP_TIMEOUT_MS through timeoutForFaces.
  heal: 300_000,
  brep_write: 120_000,
  brep_read: 120_000,
  // LINK: the solids of the design as one BREP (a brep_write plus the face walk).
  link_export: 120_000,
  measure: 60_000,
  // API 5 (P4b): copies of a large body; projection and section over every face of a large
  // import; the silhouette's hidden-line removal (HLRBRep_Algo) is the slowest of them.
  copies: 60_000,
  project: 60_000,
  section: 60_000,
  silhouette: 120_000,
  // API 6: a whole-body offset, its validity and self-interference checks; with diagnose
  // up to 10 more runs on work copies.
  offset_faces: 60_000,
};

export function timeoutFor(op: KernelOp): number {
  return OP_TIMEOUTS[op] ?? DEFAULT_TIMEOUT_MS;
}

/**
 * A body with more faces than this is "large": its exact properties are
 * measured on request, and modelling ops on it get LARGE_OP_TIMEOUT_MS
 * (KERNEL-HARDENING measured a box-minus-part cut on the 11,776-face part at
 * 22.4 s, past the 20 s default).
 */
export const LARGE_PART_FACES = 2000;
export const LARGE_OP_TIMEOUT_MS = 120_000;

/** The limit for a modelling op on inputs with this many faces in all (undefined: the op's default). */
export function timeoutForFaces(op: KernelOp, faces: number): number | undefined {
  return faces > LARGE_PART_FACES ? Math.max(LARGE_OP_TIMEOUT_MS, timeoutFor(op)) : undefined;
}

/**
 * offset_faces (a press-pull) on a body of this many faces. Up to LARGE_PART_FACES its volume check
 * integrates every B-spline face over its knot spans, and converts each face BRepOffset leaves as an
 * offset surface (about 70 ms a face): a pin cap of a 606-face lofted pin plate took 95 s, past the
 * flat 60 s, and the person got "was stopped" and a kernel restart instead of the press-pull.
 */
export const OFFSET_FACES_MS_PER_FACE = 250;
export function offsetFacesTimeout(faces: number): number {
  return timeoutForFaces('offset_faces', faces) ?? Math.max(timeoutFor('offset_faces'), Math.min(5 * 60_000, Math.ceil(faces * OFFSET_FACES_MS_PER_FACE)));
}
