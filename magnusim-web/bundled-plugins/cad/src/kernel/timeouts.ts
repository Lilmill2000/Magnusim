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
  // API 8 (Analysis Situs; measured in Node 24, 2026-11-01/02). recognize refuses a body over
  // RECOGNIZE_MAX_FACES before any work; at the limit the slowest measured body, a plate with
  // 2,000 holes (2,006 faces), takes 2.24 s (2.03 s in the app's browser worker), a 2,002-face
  // prism 0.82 s; a call that raises max_faces may take longer (a 5,000-hole plate: 13.6-15.3 s).
  recognize: 60_000,
  // suppress_blends refuses in words, before it starts, a run its cost model predicts over
  // 2 s (the kernel's budget, asi_ops.cpp; the slowest accepted measured run: 3.1 s on a
  // 663-face NIST part, where the model reads low). Around that: two recognitions (0.64 s on
  // a 1,910-face plate), the history (under 50 ms) and the result's validity check (4.6 s on
  // that plate, as for any op on it). Refused runs measured 2.6 s to 44 s (a comb of 484
  // one-face chains); before the budget they ran on into the 20 s default and killed the worker.
  suppress_blends: 60_000,
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

/**
 * API 8: the largest body whose fillets and holes are found (recognize's max_faces; the kernel's
 * own default is the same). A running call cannot be stopped, so a bigger body is refused in words
 * before any work. Measured 2026-11-01 (gate G4, Node): building the adjacency graph is quadratic
 * in the edges of the largest face and the drill-hole recogniser quadratic on a perforated plate,
 * so a 2,006-face plate with 2,000 holes takes 2.24 s and a 2,606-face one 3.7 s; 2,000 is the
 * largest size every measured body met within 3 s. Tests lower it through the page's
 * recognition client (src/kernel/recognition.ts, window.__CAD__.recognition).
 */
export const RECOGNIZE_MAX_FACES = 2000;

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
