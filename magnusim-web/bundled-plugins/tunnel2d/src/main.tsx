// Entry of the 2D Wind Tunnel workspace page (built to workspace/app.js).
// SPDX-License-Identifier: GPL-3.0-or-later
import './styles/tokens.css';
import './styles/app.css';
import { connect } from '@magnusim/workspace';
import { EmptyState } from '@magnusim/plugin-ui';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { loadScene, Saver } from './app/persist';
import { Store } from './app/store';
import { exposeTestHandle } from './app/debug';
import { SketchEditor } from './sketch/editor';
import { SketchSolver } from './sketch/solve';
import type { Palette } from './render/renderer';
import { Engine } from './sim/engine';
import { shaderErrors } from './sim/shaders';

const rootEl = document.getElementById('t2d-root') as HTMLElement;
const root = createRoot(rootEl);

function fatal(title: string, message: string) {
  root.render(
    createElement('div', { className: 't2d-fatal', role: 'alert', 'data-t2d-fatal': '1' }, createElement(EmptyState, null, createElement('strong', null, title), createElement('p', null, message))),
  );
}

/** A CSS colour (a design token) as linear 0..1 RGB. */
function tokenRgb(name: string): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = v || 'black';
  const hex = c.fillStyle as string;
  if (hex.startsWith('#')) return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  const m = /rgba?\(([^)]+)\)/.exec(hex);
  const p = m ? m[1].split(',').map(Number) : [0, 0, 0];
  return [p[0] / 255, p[1] / 255, p[2] / 255];
}

async function main() {
  let ws;
  try {
    ws = await connect({ timeoutMs: 15_000 });
  } catch (err) {
    fatal('The wind tunnel could not start', `${err instanceof Error ? err.message : String(err)}. Open the tunnel from its project in Magnusim.`);
    return;
  }

  if (!('gpu' in navigator) || !navigator.gpu) {
    fatal(
      'This wind tunnel needs WebGPU',
      'This browser does not offer WebGPU (navigator.gpu is missing), and the tunnel solves the flow on the GPU with it. Open Magnusim in a current Chrome or Edge on a computer with a GPU driver from the last few years.',
    );
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) {
    fatal('This wind tunnel needs WebGPU', 'The browser offers WebGPU but found no GPU it can use (requestAdapter gave none). Check that hardware acceleration is on in the browser’s settings and that the graphics driver is up to date.');
    return;
  }
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        // Refinement patches bind more storage buffers than the default 8 (when the GPU has them).
        maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 16),
      },
    });
  } catch (err) {
    fatal('The GPU could not be opened', String(err));
    return;
  }
  const compileError = await shaderErrors(device);
  if (compileError) {
    fatal('The wind tunnel’s GPU code did not compile on this GPU', `${compileError}. Please report this with the GPU’s name (${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}).`);
    return;
  }
  const info = adapter.info;
  const adapterName = info?.description || [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'GPU';
  void device.lost.then((l) => {
    if (l.reason === 'destroyed') return;
    fatal('The GPU stopped the wind tunnel', `${l.message || 'The GPU device was lost'}. Leave the tunnel and open it again; the scene is saved.`);
  });

  const study = ws.context.study;
  const loaded = await loadScene(ws, study.id);
  const store = new Store(loaded.scene);
  const saver = new Saver(ws, store, study.id, loaded.etag);
  if (!loaded.etag) await saver.create(loaded.scene);

  const palette: Palette = {
    bg: tokenRgb('--t2d-bg'),
    body: tokenRgb('--t2d-body'),
    edge: tokenRgb('--t2d-edge'),
    zone: [...tokenRgb('--t2d-zone'), 0.14],
    plain: tokenRgb('--t2d-plain'),
    arrow: [...tokenRgb('--t2d-arrow'), 0.85],
  };
  const canvas = document.createElement('canvas');
  const engine = new Engine(device, canvas, adapterName, palette);
  // Two lights 25 degrees over the tank, from the upper left and the lower right.
  const lightDir = (azDeg: number): [number, number, number] => {
    const el = (16 * Math.PI) / 180;
    const az = (azDeg * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  };
  const look = (name: string, d1: number, d2: number, sharp: number, glint: number) => ({
    base: tokenRgb(`--t2d-rheo-${name}-base`),
    l1: { dir: lightDir(135), color: tokenRgb(`--t2d-rheo-${name}-light1`), diffuse: d1 },
    l2: { dir: lightDir(-45), color: tokenRgb(`--t2d-rheo-${name}-light2`), diffuse: d2 },
    sharp,
    glint,
  });
  engine.rheoLooks = { kalliroscope: look('kalliroscope', 0.16, 0.12, 12, 1.8), pearl: look('pearl', 0.18, 0.14, 12, 1.6), copper: look('copper', 0.17, 0.12, 10, 1.8) };
  engine.bodyLook = { body: tokenRgb('--t2d-body-dark'), edge: tokenRgb('--t2d-edge-light') };
  engine.markerColors = {
    tracerDark: [...tokenRgb('--t2d-particle-dark'), 0.5],
    tracerLight: [...tokenRgb('--t2d-particle-light'), 0.85],
    rakes: [1, 2, 3, 4, 5, 6].map((i) => [...tokenRgb(`--mg-series-${i}`), 0.85] as [number, number, number, number]),
    // On the dark views: each series colour a third of the way to white.
    rakesOnDark: [1, 2, 3, 4, 5, 6].map((i) => {
      const c = tokenRgb(`--mg-series-${i}`);
      return [c[0] + (1 - c[0]) * 0.35, c[1] + (1 - c[1]) * 0.35, c[2] + (1 - c[2]) * 0.35, 0.85] as [number, number, number, number];
    }),
    streamline: [...tokenRgb('--t2d-streamline'), 0.4],
    streamlineLight: [...tokenRgb('--t2d-particle-light'), 0.35],
  };
  store.onSceneChange = (s) => {
    saver.schedule(s);
    void engine.setScene(s);
  };
  await engine.setScene(loaded.scene);
  engine.start();
  // The sketcher: its solver (CAD's PlaneGCS worker) starts on the first sketch edited.
  let solver: SketchSolver | null = null;
  const editor = new SketchEditor(store, engine, () => (solver ??= new SketchSolver((url) => ws.spawnWorker(url))));
  exposeTestHandle({ ws, store, engine, device, editor });
  window.addEventListener('pagehide', () => void saver.flush());

  root.render(createElement(App, { ws, store, engine, editor, units: ws.context.units, problem: loaded.problem }));
}

void main();
