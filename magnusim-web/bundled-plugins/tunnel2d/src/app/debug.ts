// window.__TUNNEL__: what the browser tests read and drive (e2e/), never the UI.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Workspace } from '@magnusim/workspace';
import type { Engine } from '../sim/engine';
import { runSchaferTurek } from '../sim/validate';
import { airfoilCase, plateCase, runCase, type AirfoilSpec, type PlateSpec } from '../sim/validateRans';
import { turnHandle, worldOutline } from '../ui/Viewport';
import { contains, signedDistance } from '../geometry/polygon';
import type { Store } from './store';

declare global {
  interface Window {
    __TUNNEL__?: Record<string, unknown>;
  }
}

export function exposeTestHandle({ store, engine, device }: { ws: Workspace; store: Store; engine: Engine; device: GPUDevice }) {
  window.__TUNNEL__ = {
    ready: true,
    scene: () => store.get().scene,
    selected: () => store.get().selected,
    save: () => store.get().save,
    stats: () => ({ ...engine.stats, map: engine.lattice, unstableAt: engine.unstableAt, limitedTotal: engine.limitedTotal }),
    view: () => ({ ...engine.worldView }),
    livePose: (id: string) => engine.livePose(id),
    bodyLive: (id: string) => engine.bodyLive(id),
    /** The displayed field sampled every 4 cells (NaN in bodies), as a plain array. */
    sampleField: async () => {
      const s = await engine.sampleField();
      return s ? Array.from(s, (v) => (Number.isFinite(v) ? v : null)) : null;
    },
    /** Screen position (CSS px, in the frame) of a world point. */
    toScreen: (x: number, y: number) => {
      const v = engine.worldView;
      const r = engine.canvas.getBoundingClientRect();
      return { x: r.left + v.w / 2 + (x - v.cx) / v.mpp, y: r.top + v.h / 2 - (y - v.cy) / v.mpp };
    },
    /** A body's turn handle and pivot (CSS px, in the frame). */
    turnHandle: (id: string) => {
      const b = store.get().scene.bodies.find((x) => x.id === id);
      if (!b) return null;
      const r = engine.canvas.getBoundingClientRect();
      const h = turnHandle(engine, b);
      return { x: r.left + h.x, y: r.top + h.y, cx: r.left + h.cx, cy: r.top + h.cy };
    },
    validate: (N = 20, tstar = 200) => runSchaferTurek(device, N, tstar),
    /** The turbulence model's checks (R1): an airfoil in a large open tunnel, a flat plate. */
    validateAirfoil: (a: AirfoilSpec) => runCase(device, airfoilCase(a)),
    validatePlate: (p: PlateSpec) => runCase(device, plateCase(p)),
    /**
     * The particles, summed up: tracers alive, each rake's particles alive and how far
     * downstream they reach (world m), any position that is not a number, and how many sit
     * inside a body (cells whose centre is more than half a cell inside, at the flow's poses).
     */
    particles: async () => {
      const r = await engine.readParticles();
      if (!r) return null;
      const scene = store.get().scene;
      const dx = r.dx;
      const bodies = scene.bodies
        .filter((b) => b.enabled)
        .map((b) => ({ b, poly: worldOutline(b, engine.livePose(b.id) ?? { x: b.x, y: b.y, angle: b.angle }) }));
      let tracersAlive = 0;
      let nan = 0;
      let inside = 0;
      const insideAt: Record<string, number>[] = [];
      const perPool = r.pools.map((p) => ({ id: p.id, alive: 0, maxX: -Infinity }));
      for (let i = 0; i < r.meta.length / 4; i++) {
        if (r.meta[4 * i + 3] < 0.5 || r.meta[4 * i] < 0) continue;
        const x = (r.pos[4 * i] + 0.5) * dx;
        const y = (r.pos[4 * i + 1] + 0.5) * dx;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          nan++;
          continue;
        }
        const src = r.meta[4 * i + 1];
        if (src < 0) tracersAlive++;
        else {
          const p = perPool[src];
          if (p) {
            p.alive++;
            p.maxX = Math.max(p.maxX, x);
          }
        }
        for (const { poly } of bodies) {
          if (contains(poly, x, y) && signedDistance(poly, x, y) < -0.5 * dx) {
            inside++;
            if (insideAt.length < 6) insideAt.push({ x, y, depthCells: signedDistance(poly, x, y) / dx, age: r.meta[4 * i], src: r.meta[4 * i + 1], prevX: (r.pos[4 * i + 2] + 0.5) * dx, prevY: (r.pos[4 * i + 3] + 0.5) * dx });
          }
        }
      }
      return { tracers: r.tracers, tracersAlive, nan, inside, insideAt, pools: perPool };
    },
    /** The dye, summed up: per channel, the total and how far downstream it reaches (world m), and dye inside bodies. */
    dye: async () => {
      const d = await engine.readDye();
      if (!d) return null;
      const sums = [0, 0, 0, 0];
      const maxX = [-Infinity, -Infinity, -Infinity, -Infinity];
      // Dye in cells whose centre is more than a cell inside a body (there should be none).
      const scene = store.get().scene;
      const polys = scene.bodies.filter((bb) => bb.enabled).map((bb) => worldOutline(bb, engine.livePose(bb.id) ?? { x: bb.x, y: bb.y, angle: bb.angle }));
      let insideSum = 0;
      for (const poly of polys) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < poly.length; i += 2) { x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]); y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]); }
        for (let j = Math.max(0, Math.floor(y0 / d.dx)); j <= Math.min(d.ny - 1, Math.ceil(y1 / d.dx)); j++) {
          for (let i = Math.max(0, Math.floor(x0 / d.dx)); i <= Math.min(d.nx - 1, Math.ceil(x1 / d.dx)); i++) {
            const x = (i + 0.5) * d.dx;
            const y = (j + 0.5) * d.dx;
            if (contains(poly, x, y) && signedDistance(poly, x, y) < -d.dx) {
              const k = j * d.nx + i;
              insideSum += d.data[4 * k] + d.data[4 * k + 1] + d.data[4 * k + 2] + d.data[4 * k + 3];
            }
          }
        }
      }
      for (let k = 0; k < d.nx * d.ny; k++) {
        for (let c = 0; c < 4; c++) {
          const v = d.data[4 * k + c];
          if (v > 0.05) {
            sums[c] += v;
            maxX[c] = Math.max(maxX[c], ((k % d.nx) + 0.5) * d.dx);
          }
        }
      }
      return { channels: d.channels, sums, maxX, insideSum };
    },
    streamlines: () => engine.streamlineCount,
    /** The rheoscopic field, summed up; null when the view is off. */
    rheo: () => engine.readRheo(),
  };
}
