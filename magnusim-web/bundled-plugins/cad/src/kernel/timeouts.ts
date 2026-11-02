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
  // API 8/9 (Analysis Situs; measured in Node 24 and the app's browser worker, 2026-11-02).
  // recognize refuses a body over RECOGNIZE_MAX_FILLET_FACES or RECOGNIZE_MAX_HOLE_FACES before
  // any work; at those limits the slowest measured bodies take 1.00 s (fillets: a 5,010-face
  // rounded comb) and 2.52 s (holes: a 2,606-face perforated plate); a call that raises them may
  // take longer (a 10,002-face prism 4.7 s, a 5,000-hole plate over 10 s).
  recognize: 60_000,
  // suppress_blends refuses in words, before it starts, a run its cost model predicts over
  // 1.4 s (the kernel's budget, kSuppressBudgetMs in asi_ops.cpp; the slowest accepted measured
  // run: 3.1 s for the root fillets of a 5 x 6 pin-fin heat sink, where the model reads low).
  // Around that: two recognitions (0.64 s on a 1,910-face plate), the history (under 50 ms) and
  // the result's validity check (about 4 s of a 5.7 s run on a plate of 1,900 holes, as for any
  // op on it). Refused runs measured 1.4 s to 37 s; before the budget they ran on into the 20 s
  // default and killed the worker.
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
 * API 9: the largest body whose fillets are found (recognize's max_fillet_faces, for a search
 * without holes; the kernel's own default is the same). A running call cannot be stopped, so a
 * bigger body is refused in words before any work. The rule (gate G4): the slowest measured body
 * at the limit takes at most 3 s in Node and 4.5 s in the app's browser worker. Measured
 * 2026-11-02 on kernel API 9, whose adjacency graph reads its cached edge map by reference (2.5 to
 * 3.4 times faster on the bodies that bind): bodies whose few faces carry every edge bind it, a
 * rounded comb of 5,010 faces 1.00 s in Node (0.87 s in the browser), a 620-tooth gear with
 * rounded teeth (4,983 faces) 0.98 s, a 5,002-sided prism 0.74 s; real parts near 5,000 faces
 * (heat sinks, brackets, patterned NIST parts) 0.31-0.95 s. The rule would allow about 8,900
 * faces (the comb of 8,890 faces: 2.84 s); 5,000 leaves about 3 times that margin.
 */
export const RECOGNIZE_MAX_FILLET_FACES = 5000;

/**
 * API 9: the largest body whose drilled holes are found (recognize's max_hole_faces, for any
 * search with holes, fillets and holes together too): the drill-hole recogniser is quadratic. A
 * plain perforated plate with one face per hole binds it: 2,606 faces take 2.52 s in Node (the
 * slowest of four quiet runs; 2.49 s in the browser), 2,806 faces 2.94 s and 2,906 faces 3.23 s,
 * over the rule. With other work on the machine the 2,606-face plate took up to 3.45 s, so the
 * limit stays at 2,600 rather than the rule's 2,800. Real parts with holes near 2,600 faces (a
 * plate and an L bracket with rounded hole rims, patterned NIST parts) take 0.53-0.73 s.
 * Tests lower both limits through the page's recognition client (src/kernel/recognition.ts,
 * window.__CAD__.recognition).
 */
export const RECOGNIZE_MAX_HOLE_FACES = 2600;

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
