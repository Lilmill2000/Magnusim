// The picking worker: builds a body's BVH off the main thread (a 550k-triangle
// part blocked the frame for 170-260 ms in P0) and sends the buffers back.
// Built by scripts/build.mjs (WORKERS) into workspace/pick/pick-worker.js as
// one self-contained module; started with ws.spawnWorker().
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { buildBvhBuffers, type BvhReply, type BvhRequest } from './bvh-build';

const scope = self as unknown as { onmessage: ((e: MessageEvent<BvhRequest>) => void) | null; postMessage(msg: BvhReply, transfer: Transferable[]): void };

scope.onmessage = (e: MessageEvent<BvhRequest>) => {
  const { id, positions, indices } = e.data;
  const t0 = performance.now();
  try {
    const b = buildBvhBuffers(positions, indices);
    const reply: BvhReply = { id, ok: true, roots: b.roots, indirect: b.indirect, ms: performance.now() - t0 };
    scope.postMessage(reply, [...b.roots, b.indirect.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
