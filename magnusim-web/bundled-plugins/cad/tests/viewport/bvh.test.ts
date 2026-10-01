// @vitest-environment node
// BVH builds: small bodies on the main thread, large ones through the picking
// worker (here a fake worker running the real worker code path), and a
// fallback to the main thread when the worker cannot start or dies.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BvhClient, type BvhBuilt } from '../../src/viewport/bvh';
import { buildBvhBuffers, type BvhReply, type BvhRequest } from '../../src/viewport/bvh-build';

/** A grid of n x n quads in z = 0 (2 n^2 triangles). */
function grid(n: number): BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i, j, 0);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(idx), 1));
  return g;
}

/** A Worker stand-in that answers with the worker module's own code path, asynchronously. */
class FakePickWorker {
  onmessage: ((e: MessageEvent<BvhReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted = 0;
  terminated = false;
  constructor(private readonly fail = false) {}
  postMessage(msg: BvhRequest) {
    this.posted++;
    setTimeout(() => {
      if (this.fail) {
        this.onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent);
        return;
      }
      const b = buildBvhBuffers(msg.positions, msg.indices);
      this.onmessage?.({ data: { id: msg.id, ok: true, roots: b.roots, indirect: b.indirect, ms: 1 } } as MessageEvent<BvhReply>);
    }, 1);
  }
  terminate() {
    this.terminated = true;
  }
}

function hitFace(bvh: BvhBuilt['bvh']) {
  const ray = new Ray(new Vector3(3.25, 5.75, 10), new Vector3(0, 0, -1));
  return bvh.raycastFirst(ray, DoubleSide)?.faceIndex;
}

afterEach(() => vi.restoreAllMocks());

describe('BvhClient', () => {
  it('builds small bodies on the main thread right away', () => {
    const spawn = vi.fn();
    const c = new BvhClient({ spawnWorker: spawn, workerUrl: 'x', workerTriangles: 1000 });
    const g = grid(10);
    let done: { worker: boolean } | null = null;
    c.build(g, 200, (r) => (done = r));
    expect(done).toMatchObject({ worker: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('builds large bodies in the worker; hits match a main-thread build and the index is untouched', async () => {
    const w = new FakePickWorker();
    const c = new BvhClient({ spawnWorker: () => w as unknown as Worker, workerUrl: 'x', workerTriangles: 1000 });
    const g = grid(40);
    const before = (g.getIndex()!.array as Uint32Array).slice();
    const r = await new Promise<BvhBuilt>((res, rej) => c.build(g, 3200, res, rej));
    expect(r.worker).toBe(true);
    expect(w.posted).toBe(1);
    const sync = new BvhClient({});
    const s = await new Promise<BvhBuilt>((res) => sync.build(grid(40), 3200, res));
    expect(hitFace(r.bvh)).toBe(hitFace(s.bvh));
    // Quad (3, 5) of a 40-wide grid: triangles 2 * (5 * 40 + 3) and +1.
    expect([406, 407]).toContain(hitFace(r.bvh));
    expect([...(g.getIndex()!.array as Uint32Array)]).toEqual([...before]);
  });

  it('a cancelled build never reports', async () => {
    const w = new FakePickWorker();
    const c = new BvhClient({ spawnWorker: () => w as unknown as Worker, workerUrl: 'x', workerTriangles: 10 });
    const done = vi.fn();
    const cancel = c.build(grid(10), 200, done);
    cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(done).not.toHaveBeenCalled();
  });

  it('falls back to the main thread when the worker cannot start or dies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new BvhClient({
      spawnWorker: () => {
        throw new Error('blocked');
      },
      workerUrl: 'x',
      workerTriangles: 10,
    });
    let r: { worker: boolean } | null = null;
    c.build(grid(10), 200, (x) => (r = x));
    expect(r).toMatchObject({ worker: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/picking worker unavailable \(blocked\)/));

    const dying = new FakePickWorker(true);
    const d = new BvhClient({ spawnWorker: () => dying as unknown as Worker, workerUrl: 'x', workerTriangles: 10 });
    const res = await new Promise<{ worker: boolean }>((ok) => d.build(grid(10), 200, ok));
    expect(res.worker).toBe(false);
    expect(dying.terminated).toBe(true);
  });
});
