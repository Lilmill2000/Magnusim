// @vitest-environment node
// P0 gate 9, out of memory: the heap is filled to the 4 GB wasm32 ceiling, then real
// modelling ops run. Each must come back as a catchable error (ok:false, oom), not a
// trap or a hang, and the kernel must work again once memory is free. The kernel
// runs in a worker thread with a wall-clock watchdog, as on the page. It holds up
// to 4 GB while it runs.
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itVortex, KERNEL_DIR, REF, rel, vortexBytes, type R } from './kernel-lib';

let w: Worker;
function send(op: string, params: R = {}, bytes?: Uint8Array, timeoutMs = 60_000): Promise<R> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watchdog: ${op} did not answer in ${timeoutMs / 1000} s`)), timeoutMs);
    w.once('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    const buf = bytes ? bytes.slice().buffer : undefined;
    w.postMessage({ op, params, bytes: buf }, buf ? [buf] : []);
  });
}

beforeAll(async () => {
  w = new Worker(new URL('./kernel-oom-worker.mjs', import.meta.url), { workerData: { dir: KERNEL_DIR } });
  await new Promise((resolve, reject) => {
    w.once('message', resolve);
    w.once('error', reject);
  });
});
afterAll(async () => {
  await w?.terminate();
});

async function alive(): Promise<boolean> {
  const b = await send('box', { dx: 1, dy: 2, dz: 3 });
  if (!b.ok) return false;
  const p = await send('props', { id: b.id, volume: true, bbox: 'none' });
  await send('release', { ids: [b.id] });
  return p.ok && Math.abs(p.volume - 6) < 1e-9;
}

describe('gate 9: out of memory', () => {
  it('mk_alloc past the 4 GB ceiling returns null', async () => {
    expect(await send('__alloc', { bytes: 2 ** 32 - 1 })).toEqual({ ok: true, ptr: 0 });
    expect(await alive()).toBe(true);
  });

  it("OCCT's allocator running out is ok:false with oom, and the kernel keeps working", async () => {
    const r = await send('debug_oom', { step_mb: 64 }, undefined, 120_000);
    expect(r).toMatchObject({ ok: false, oom: true });
    const heap = await send('__heap');
    expect(heap.heap_bytes).toBeGreaterThan(3.9 * 2 ** 30);
    expect(await alive()).toBe(true);
  }, 180_000);

  itVortex('real ops on a full heap fail cleanly; after freeing, import + cut work again', async () => {
    const hold = await send('debug_hold', { leave_mb: 4 }, undefined, 120_000);
    expect(hold.ok).toBe(true);
    expect(hold.held_mb).toBeGreaterThan(3500);
    const bytes = vortexBytes();
    const failures: R[] = [];
    // About 16 MB are left: enough to import the 64 KB part and make a box.
    const imp = await send('import_step', { name: 'vortex.step', heal: true, tol: 1e-3 }, bytes);
    expect(imp.ok).toBe(true);
    const id = imp.shapes[0].id;
    const box = await send('box', { origin: [-300, -300, -700], dx: 600, dy: 600, dz: 1200 });
    expect(box.ok).toBe(true);
    // Keep the results of cuts until memory runs out, then a fine mesh.
    let cuts = 0;
    for (; cuts < 1000; cuts++) {
      const c = await send('boolean', { op: 'cut', targets: [box.id], tools: [id], check: false });
      if (!c.ok) {
        failures.push({ step: 'boolean', ...c });
        break;
      }
    }
    expect(cuts).toBeGreaterThan(0);
    const t = await send('tessellate', { id, lin_defl: 0.005 });
    if (!t.ok) failures.push({ step: 'tessellate', ...t });
    expect(failures.map((f) => f.step)).toEqual(['boolean', 'tessellate']);
    for (const f of failures) {
      expect(f.kind).not.toBe('trap');
      expect(f.oom, JSON.stringify(f)).toBe(true);
      expect(f.error).toMatch(/out of memory/);
    }
    // Free the held memory: the same instance works again.
    expect((await send('debug_hold', { free: true })).ok).toBe(true);
    await send('release', { all: true });
    const again = await send('import_step', { name: 'vortex.step', heal: true, tol: 1e-3 }, bytes);
    expect(again.ok).toBe(true);
    const fb = REF.fluid_box;
    const fluidBox = await send('box', { origin: fb.origin, dx: fb.dx, dy: fb.dy, dz: fb.dz });
    const cut = await send('boolean', { op: 'cut', targets: [fluidBox.id], tools: [again.shapes[0].id] });
    expect(cut).toMatchObject({ ok: true, valid: true });
    const p = await send('props', { id: cut.id, volume: true, bbox: 'none' });
    expect(rel(p.volume, REF.cut_fluid.volume)).toBeLessThan(1e-6);
  }, 300_000);
});
