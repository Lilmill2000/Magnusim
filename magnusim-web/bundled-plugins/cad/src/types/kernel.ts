// The main-thread side of the kernel: KernelAdapter (over the worker protocol,
// with the wall-clock watchdog) and the geometry payloads the viewport shows.
// Owner: DOC-CORE (adapter). KERNEL-HARDENING owns kernel-protocol.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, FeatureId } from './doc';
import type { BBox, KernelErrorKind, KernelOp, KernelParams, KernelResult, ShapeId } from './kernel-protocol';
import type { FaceNames } from './naming';
import type { ReadonlyStateStore } from './state';

export type KernelState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'closed';

export interface KernelReadyInfo {
  occt: string;
  variant: 'wasm32';
  /** Spawn to `ready`, measured on the frame's main thread. */
  ready_ms: number;
  init_ms: number;
  heap_bytes: number;
}

export interface KernelStatus {
  state: KernelState;
  info: KernelReadyInfo | null;
  /** Why it failed or restarted, in words a user can read ("stopped after 20.0 s"). */
  message: string | null;
  respawns: number;
  /** The op running right now (for a "Rebuilding…" chip), or null. */
  busy: KernelOp | null;
  /** The worker's wasm heap after its last reply (it never shrinks), or null before the first. */
  heap_bytes: number | null;
  /**
   * The heap stayed above the recycle threshold (1.2 GB) even after a fresh
   * worker rebuilt the part: no more recycling (no loop). The UI may show
   * "Large model · 1.4 GB memory".
   */
  memory_high: boolean;
}

/** Recycle the worker at the next idle moment when its heap is above this (bytes). */
export const KERNEL_RECYCLE_BYTES = 1.2e9;

/**
 * Why a call failed. `watchdog`: stopped after its timeout (the worker was
 * respawned); `restarted`: queued when the worker was respawned (its shape ids
 * died); `boot`: the kernel never became ready; others come from the facade.
 */
/** 'cancelled': the caller's AbortSignal stopped the call (the error's name is also AbortError). */
export type KernelCallErrorKind = KernelErrorKind | 'watchdog' | 'restarted' | 'boot' | 'crash' | 'cancelled';

export interface KernelCallError extends Error {
  kind: KernelCallErrorKind;
  op: KernelOp;
  oom?: boolean;
  /** For watchdog stops. */
  seconds?: number;
}

export interface KernelReply<Op extends KernelOp> {
  result: KernelResult<Op>;
  buffers: Record<string, ArrayBuffer>;
  /** Time inside the worker, and wall time from send to reply (ms). */
  ms: number;
  wall_ms: number;
  heap_bytes: number;
}

export interface KernelCallOptions {
  /** Transferred to the worker; the facade receives it as params.ptr/len. */
  bytes?: ArrayBuffer;
  /** Overrides the per-op timeout (src/kernel/timeouts.ts). */
  timeoutMs?: number;
  /**
   * Stops the call: a queued call is dropped; a call the worker is running is
   * cut off by terminating the worker and starting a fresh one (a kernel op
   * cannot be interrupted; every shape id dies and onRespawn listeners rebuild
   * from the document). Either way the call rejects with kind 'cancelled'
   * (name AbortError). Used by long user-started ops (an import's read and
   * heal) so their Cancel frees the kernel at once.
   */
  signal?: AbortSignal;
}

/**
 * One kernel worker, one call at a time, in order. Every call has a wall-clock
 * watchdog (20 s default, per-op overrides); on expiry the worker is terminated
 * and respawned, the call rejects with kind "watchdog" and queued calls with
 * "restarted". After any respawn every ShapeId is gone: listeners of
 * onRespawn (the rebuild engine) rebuild from the document.
 */
export interface KernelAdapter {
  readonly status: ReadonlyStateStore<KernelStatus>;
  /** Spawns the worker; resolves on the ready handshake. Safe to call twice. */
  start(): Promise<KernelReadyInfo>;
  call<Op extends KernelOp>(op: Op, params: KernelParams<Op>, opts?: KernelCallOptions): Promise<KernelReply<Op>>;
  /** Called after a respawn (watchdog, trap, crash, memory recycle) once the new worker is ready. */
  onRespawn(fn: (reason: string) => void): () => void;
  /** Terminate and start again (a user's Retry after a failed start). */
  restart(reason: string): Promise<KernelReadyInfo>;
  /**
   * At an idle moment: if the heap is above KERNEL_RECYCLE_BYTES, start a fresh
   * worker (onRespawn listeners rebuild). Once only: when a recycled worker is
   * above the threshold again, `memory_high` is set and nothing restarts
   * until the heap has been below it. Resolves true when it recycled.
   */
  recycleIfLarge(): Promise<boolean>;
  dispose(): void;
}

/**
 * Tessellation of one body, as the kernel's `tessellate` returns it (typed).
 * faceRanges[2k], faceRanges[2k+1] = start and count in `indices` of face k.
 * edgeRanges[2k], edgeRanges[2k+1] = start point and point count in
 * `edgePositions` (segment pairs) of edge k.
 */
export interface TessPayload {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array;
  edgePositions: Float32Array;
  edgeRanges: Uint32Array;
  /**
   * One byte per edge index (EDGE_FLAG bits in kernel-protocol.ts): edges with
   * EDGE_HIDDEN bits (seams, poles, same-domain splits) are not model edges and
   * are not drawn. null/absent when the kernel did not send them.
   */
  edgeFlags?: Uint8Array | null;
}

/** A built body at the rollback position: what the viewport draws and the tree lists. */
export interface BodyInfo {
  id: BodyId;
  name: string;
  color: string;
  /** The feature that last changed this body. */
  feature: FeatureId;
  /** Kernel id in the current worker (dies on respawn). */
  shape: ShapeId;
  valid: boolean;
  faces: number;
  edges: number;
  /** Exact once measured; from the tessellation before that (large parts). */
  bbox: BBox;
  /** mm³, when measured (lazy on large parts: DocService.measure). */
  volume: number | null;
  /** mm², when measured (with the volume). */
  area: number | null;
  /**
   * Solids in the body, when measured. 0 = a surface body (an open shell, e.g. an
   * import before knitting): it has no volume, whatever BRepGProp integrates over its faces.
   */
  solids?: number | null;
  visible: boolean;
  /** Changes whenever the geometry changes; the viewport re-uploads only on a new key. */
  tessKey: string;
  tess: TessPayload | null;
  /** Its faces' persistent names (panels list faces by them; references store them), or null when none were made. */
  names?: FaceNames | null;
}
