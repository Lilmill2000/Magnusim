// window.__TUNNEL__: what the browser tests read and drive (e2e/), never the UI.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Workspace } from '@magnusim/workspace';
import type { Engine } from '../sim/engine';
import { runSchaferTurek } from '../sim/validate';
import { turnHandle } from '../ui/Viewport';
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
  };
}
