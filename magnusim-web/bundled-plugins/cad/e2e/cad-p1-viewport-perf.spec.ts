// Viewport performance on the P0 large part (Daniel's 118 MB STEP: 11,776 faces,
// 27,560 edges, 553,737 triangles), in the Part's sandboxed frame: the kernel's
// tessellation of it (a fixture written by the kernel in Node, served into the
// frame's own folder by the test) goes through the viewport's setBodies. Measured:
// main-thread time to build the body, the first (upload) frame, long tasks, the
// BVH build (must run in the picking worker), orbit frame rate while dragging,
// GPU-synced ms per frame, and hover-pick time (faces + 27k edges + 16k vertices).
// The fixture is not in the repository (it comes from a private file): without
// it the test is skipped and says so. Frame-rate gates apply on a hardware GPU;
// on a software renderer (bundled Chromium's SwiftShader) the numbers are only
// reported.
//   CAD_E2E_LARGE_TESS=<path to large-tess.bin>   CAD_E2E_PERF_OUT=<json file>
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { newPartFromTree, newProject, openProject, partOpened, watchPage, workspaceFrame } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type W = { __CAD__: { services: any }; __perf?: any };

const FIXTURE = process.env.CAD_E2E_LARGE_TESS || '';
const PERF_URL = '__perf/large-tess.bin';

test('cad:p1-viewport-perf the 553k-triangle part: setBodies, BVH in the worker, orbit fps, pick time', { tag: '@serial' }, async ({ page, request }, info) => {
  test.skip(!FIXTURE || !existsSync(FIXTURE), 'CAD_E2E_LARGE_TESS does not name the large-part tessellation fixture');
  test.setTimeout(240_000);
  const seen = await watchPage(page);
  const body = readFileSync(FIXTURE);
  await page.route(`**/plugins/cad/workspace/${PERF_URL}`, (route) =>
    route.fulfill({ status: 200, body, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } }),
  );
  const projectId = await newProject(request);
  await openProject(page, projectId);
  await newPartFromTree(page, 'Large part');
  const f = await partOpened(page);
  await expect(f.locator('[data-cad-app]')).toHaveAttribute('data-doc', 'ready');
  const frame = workspaceFrame(page);

  // Load: fetch + parse (not timed as viewport work), then setBodies and the first frame.
  const load = await frame.evaluate(async (url) => {
    const w = window as unknown as W;
    const h = w.__CAD__.services.viewport.get().handle;
    const longTasks: number[] = [];
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(e.duration);
    });
    try {
      po.observe({ type: 'longtask', buffered: false });
    } catch {
      /* no longtask support */
    }
    const buf = await (await fetch(new URL(url, document.baseURI).href)).arrayBuffer();
    const hl = new DataView(buf).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const base = 4 + hl;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const part = (name: string): any => {
      const p = header.parts.find((x: { name: string }) => x.name === name);
      const slice = buf.slice(base + p.offset, base + p.offset + p.length * 4);
      return p.type === 'u32' ? new Uint32Array(slice) : new Float32Array(slice);
    };
    const tess = { positions: part('positions'), normals: part('normals'), indices: part('indices'), faceRanges: part('face_ranges'), edgePositions: part('edge_positions'), edgeRanges: part('edge_ranges') };
    const vertices = header.parts.some((x: { name: string }) => x.name === 'vertices') ? part('vertices') : null;
    const canvas = document.querySelector('.cad-viewport-canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    longTasks.length = 0;
    const t0 = performance.now();
    h.setBodies([{ id: 'b_large', color: '#bdc9db', visible: true, tessKey: 'large', tess, vertices }]);
    const setMs = performance.now() - t0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const firstFrameWall = performance.now() - t0;
    const st = h.stats();
    // Time until the part is pickable (BVH from the worker).
    while (h.state.get().bvhPending > 0 && performance.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 20));
    const pickableMs = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
    po.disconnect();
    const s2 = h.stats();
    return {
      renderer,
      header: { faces: header.faces, edges: header.edges, triangles: header.triangles, vertices: header.vertices },
      triangles: h.state.get().triangles,
      setBodiesMs: setMs,
      statsSetBodiesMs: st.lastSetBodiesMs,
      uploadFrameMs: st.lastUploadFrameMs,
      firstFrameWallMs: firstFrameWall,
      pickableMs,
      bvh: s2.bvh.b_large,
      longTasks: longTasks.map((x) => Math.round(x)),
    };
  }, PERF_URL);

  // Orbit: a left drag moved every animation frame for 3 s (the user's case: one render per frame).
  const orbit = await frame.evaluate(async () => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    const c = document.querySelector('.cad-viewport-canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    let x = r.left + r.width * 0.3;
    const y = r.top + r.height * 0.5;
    const ev = (type: string, px: number, buttons: number) =>
      c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: px, clientY: y, bubbles: true }));
    ev('pointerdown', x, 1);
    x += 8;
    ev('pointermove', x, 1);
    await new Promise((res) => requestAnimationFrame(res));
    const f0 = h.stats().frames;
    const t0 = performance.now();
    const intervals: number[] = [];
    const cpu: number[] = [];
    let last = t0;
    await new Promise<void>((res) => {
      const step = (now: number) => {
        intervals.push(now - last);
        last = now;
        cpu.push(h.stats().lastFrameMs);
        x += 3;
        ev('pointermove', x, 1);
        if (now - t0 < 3000) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    ev('pointerup', x, 0);
    const secs = (performance.now() - t0) / 1000;
    const frames = h.stats().frames - f0;
    intervals.shift();
    const sorted = [...intervals].sort((a, b) => a - b);
    const cpuSorted = [...cpu].sort((a, b) => a - b);
    return {
      fps: frames / secs,
      frames,
      rafP50: sorted[Math.floor(sorted.length * 0.5)],
      rafP95: sorted[Math.floor(sorted.length * 0.95)],
      rafMax: sorted[sorted.length - 1],
      renderCpuP50: cpuSorted[Math.floor(cpuSorted.length * 0.5)],
      renderCpuP95: cpuSorted[Math.floor(cpuSorted.length * 0.95)],
      drawCalls: h.stats().drawCalls,
    };
  });

  // GPU-synced: draw 60 frames back to back, waiting for the GPU after each.
  const gpu = await frame.evaluate(() => (window as unknown as W).__CAD__.services.viewport.get().handle.measure(60));

  // Hover picking on the large part: faces through the BVH, 27k edges and 16k vertices in screen space.
  const pick = await frame.evaluate(async () => {
    const h = (window as unknown as W).__CAD__.services.viewport.get().handle;
    h.fit({ animate: false });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.querySelector('.cad-viewport-canvas') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const times: number[] = [];
    const kinds: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const px = r.left + r.width * (0.3 + 0.4 * ((i * 7) % 40) / 40);
      const py = r.top + r.height * (0.3 + 0.4 * ((i * 13) % 40) / 40);
      const t0 = performance.now();
      const p = h.pick(px, py);
      times.push(performance.now() - t0);
      const k = p ? p.item.kind : 'none';
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    times.sort((a, b) => a - b);
    return { p50: times[20], p95: times[38], max: times[39], kinds };
  });

  const result = { browser: info.project.name, ...load, orbit, gpu, pick };
  if (process.env.CAD_E2E_SHOTS) await page.screenshot({ path: process.env.CAD_E2E_SHOTS + '/viewport-large-' + info.project.name + '.png' });
  console.log(`[cad-perf] ${JSON.stringify(result)}`);
  info.annotations.push({ type: 'perf', description: JSON.stringify(result) });
  if (process.env.CAD_E2E_PERF_OUT) {
    const out = process.env.CAD_E2E_PERF_OUT;
    const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
    writeFileSync(out, JSON.stringify([...prev, result], null, 1));
  }

  // What must hold everywhere.
  expect(load.triangles).toBe(553_737);
  expect(load.bvh?.worker, 'the BVH is built in the picking worker').toBe(true);
  expect(load.setBodiesMs, 'setBodies on the main thread').toBeLessThan(400);
  expect(40 - (pick.kinds.none ?? 0), 'picks that hit the part (faces, edges, vertices)').toBeGreaterThanOrEqual(10);
  expect(seen.csp, 'CSP violations').toEqual([]);
  expect(seen.errors, 'console errors').toEqual([]);
  // Frame-rate gates on a hardware GPU (the proposal's budget: 60 fps orbit at 500k triangles).
  if (!/SwiftShader|llvmpipe|Software/i.test(load.renderer)) {
    expect(orbit.fps, `orbit fps on ${load.renderer}`).toBeGreaterThanOrEqual(55);
    expect(gpu.msPerFrame, 'GPU-synced ms per frame').toBeLessThan(16.7);
    expect(pick.p95, 'hover pick p95 (ms)').toBeLessThan(16);
  }
});
