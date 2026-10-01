// @vitest-environment node
// The shipped kernel (workspace/kernel/mk32.*) loaded in Node through the same
// wrapper the worker uses: version, a box, props, check, tessellate buffers.
// Owner: KERNEL-HARDENING (extend with the op gates).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createKernel } from '../../src/kernel-worker/kernel-api';

const DIR = process.env.CAD_KERNEL_DIR || fileURLToPath(new URL('../../workspace/kernel/', import.meta.url));
const MODULE = join(DIR, 'mk32.mjs');
const WASM = join(DIR, 'mk32.wasm');

describe('kernel (wasm32, Node)', () => {
  it('starts, builds a box and reports exact properties', async () => {
    const k = await createKernel({ moduleUrl: pathToFileURL(MODULE).href, wasmBinary: readFileSync(WASM) });
    expect(k.version.occt).toBe('7.9.3');
    const box = k.call('box', { dx: 10, dy: 20, dz: 30 });
    const id = box.id as number;
    const props = k.call('props', { id, volume: true, area: true });
    expect(props.volume).toBeCloseTo(6000, 9);
    expect(props.area).toBeCloseTo(2 * (200 + 300 + 600), 9);
    expect(props.faces).toBe(6);
    expect(box.valid).toBe(true);
    expect(k.call('check', { id }).valid).toBe(true);
    const t = k.call('tessellate', { id });
    const bufs = k.takeBuffers(t);
    expect(Object.keys(bufs).sort()).toEqual(['edge_flags', 'edge_positions', 'edge_ranges', 'face_ranges', 'indices', 'normals', 'positions']);
    expect(bufs.face_ranges.length).toBe(12);
    expect(bufs.edge_ranges.length).toBe(24);
    expect(bufs.indices.length).toBe(3 * (t.triangles as number));
    k.call('release', { ids: [id] });
    const bad = k.tryCall('box', { dx: 1 });
    expect(bad.ok).toBe(false);
  });
});
