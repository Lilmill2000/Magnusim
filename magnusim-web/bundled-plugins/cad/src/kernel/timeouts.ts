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
