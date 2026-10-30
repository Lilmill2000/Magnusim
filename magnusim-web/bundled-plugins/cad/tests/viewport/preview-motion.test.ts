// The view draws bodies moved by a rigid motion without a rebuild (ViewportHandle.previewMotion:
// Move/copy body's drag handle): the real viewport on a stand-in for three's WebGLRenderer (jsdom
// has no WebGL) that records where each body's faces and edges are drawn at each render:
//   - the faces and the edges move together (drawnBox says where the body is drawn); null puts
//     them back where they are built; other bodies stay;
//   - a body drawn anew (a new tessKey: the rebuild that puts it there) starts unmoved; one whose
//     tessKey stays keeps the motion until null;
//   - a preview asks for a frame, and moves no camera.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BoxGeometry, type Object3D } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../../src/types/doc';
import type { TessPayload } from '../../src/types/kernel';
import type { ViewportHandle } from '../../src/types/viewport';
import { createViewport } from '../../src/viewport/viewport';

/** Each named body object's world matrix translation at each render (faces 'body:', edges 'edges:'). */
const gpu = vi.hoisted(() => ({ renders: [] as Record<string, number[]>[] }));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StandInRenderer {
    domElement = document.createElement('canvas');
    info = { render: { calls: 0 }, autoReset: true };
    capabilities = { maxSamples: 4, maxTextureSize: 8192 };
    autoClear = true;
    localClippingEnabled = false;
    target: unknown = null;
    setPixelRatio() {}
    setClearColor() {}
    getClearColor<T>(c: T) {
      return c;
    }
    getClearAlpha() {
      return 1;
    }
    setSize() {}
    setScissorTest() {}
    setScissor() {}
    setViewport() {}
    clear() {}
    clearDepth() {}
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    render(scene: Object3D) {
      scene.updateMatrixWorld();
      const seen: Record<string, number[]> = {};
      scene.traverse((o) => {
        if (o.name.startsWith('body:') || o.name.startsWith('edges:')) seen[o.name] = o.matrixWorld.elements.slice(12, 15).map((v) => v + 0);
      });
      gpu.renders.push(seen);
    }
    readRenderTargetPixels() {}
    getContext() {
      return { isContextLost: () => false, readPixels() {}, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401 };
    }
    dispose() {}
  }
  return { ...three, WebGLRenderer: StandInRenderer };
});

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** A cube from `at` with side `s` (faces and edges). */
function cubeTess(at: Vec3, s: number): TessPayload {
  const g = new BoxGeometry(s, s, s).translate(at[0] + s / 2, at[1] + s / 2, at[2] + s / 2);
  const pts: number[] = [];
  for (const i of [0, 1])
    for (const j of [0, 1])
      for (const k of [0, 1]) {
        const c = [i, j, k];
        for (let a = 0; a < 3; a++) {
          if (c[a]) continue;
          const d = [...c];
          d[a] = 1;
          pts.push(...c.map((v, n) => at[n] + v * s), ...d.map((v, n) => at[n] + v * s));
        }
      }
  return {
    positions: new Float32Array(g.getAttribute('position').array),
    normals: new Float32Array(g.getAttribute('normal').array),
    indices: new Uint32Array(g.getIndex()!.array),
    faceRanges: new Uint32Array(g.groups.flatMap((gr) => [gr.start, gr.count])),
    edgePositions: new Float32Array(pts),
    edgeRanges: new Uint32Array(Array.from({ length: 12 }, (_, e) => [2 * e, 2]).flat()),
  };
}

const opened: ViewportHandle[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.dispose();
  document.body.innerHTML = '';
  gpu.renders.length = 0;
  vi.useRealTimers();
});

function viewport() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 800 });
  Object.defineProperty(host, 'clientHeight', { value: 600 });
  document.body.appendChild(host);
  const h = createViewport(host, { spawnWorker: null });
  opened.push(h);
  h.setBodies([
    { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1', tess: cubeTess([0, 0, 0], 10) },
    { id: 'b_2', color: '#bdc9db', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
  ]);
  return h;
}

/** The next frame's main render (the triad's own scene has no bodies), or null when no frame is drawn. */
const frame = () => {
  const n = gpu.renders.length;
  vi.advanceTimersByTime(50);
  return gpu.renders.slice(n).filter((r) => Object.keys(r).length).pop() ?? null;
};
const box = (h: ViewportHandle, id: string) => {
  const b = h.drawnBox!(id)!;
  return [...b.min, ...b.max].map((v) => Math.round(v * 1e9) / 1e9 + 0);
};
/** A turn of 90 deg about Z through (5, 5, 0), then 30 along X (3x4 row-major). */
const TURN_AND_MOVE = [0, -1, 0, 40, 1, 0, 0, 0, 0, 0, 1, 0];

describe('previewMotion', () => {
  it('draws the faces and the edges moved together, asks for a frame, moves no camera; null puts them back; other bodies stay', () => {
    const h = viewport();
    frame();
    const camera = h.camera();
    const moves = h.userCameraMoves!();
    h.previewMotion!(['b_1'], TURN_AND_MOVE);
    const seen = frame();
    expect(seen, 'a frame drawn').not.toBeNull();
    expect(seen!['body:b_1']).toEqual([40, 0, 0]);
    expect(seen!['edges:b_1']).toEqual([40, 0, 0]);
    expect(seen!['body:b_2']).toEqual([0, 0, 0]);
    // The cube [0, 10]^3 turned about (5, 5) is where it was; then 30 along X.
    expect(box(h, 'b_1')).toEqual([30, 0, 0, 40, 10, 10]);
    expect(box(h, 'b_2')).toEqual([20, 0, 0, 30, 10, 10]);
    expect(h.camera()).toEqual(camera);
    expect(h.userCameraMoves!()).toBe(moves);
    h.previewMotion!(['b_1'], null);
    expect(frame()!['body:b_1']).toEqual([0, 0, 0]);
    expect(box(h, 'b_1')).toEqual([0, 0, 0, 10, 10, 10]);
  });

  it('a body drawn anew (a new tessKey) starts unmoved; one whose tessKey stays keeps the motion until null', () => {
    const h = viewport();
    h.previewMotion!(['b_1', 'b_2'], [1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(box(h, 'b_1')[0]).toBe(7);
    // The rebuild that put b_1 there: new geometry, drawn as built. b_2 is the same body as before.
    h.setBodies([
      { id: 'b_1', color: '#bdc9db', visible: true, tessKey: 'k1b', tess: cubeTess([7, 0, 0], 10) },
      { id: 'b_2', color: '#bdc9db', visible: true, tessKey: 'k2', tess: cubeTess([20, 0, 0], 10) },
    ]);
    const seen = frame()!;
    expect(seen['body:b_1']).toEqual([0, 0, 0]);
    expect(box(h, 'b_1')).toEqual([7, 0, 0, 17, 10, 10]);
    expect(seen['body:b_2']).toEqual([7, 0, 0]);
    h.previewMotion!(['b_2', 'b_gone'], null);
    expect(box(h, 'b_2')).toEqual([20, 0, 0, 30, 10, 10]);
    expect(h.drawnBox!('b_gone')).toBeNull();
  });
});
