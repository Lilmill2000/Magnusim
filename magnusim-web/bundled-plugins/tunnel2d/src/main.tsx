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
import { SweepHost } from './sim/sweep';
import { ProbeFeed } from './ui/probeFeed';
import { applyViewColours, viewPalette } from './app/colours';
import { Engine } from './sim/engine';
import { shaderErrors } from './sim/shaders';
import { gpuHelp, webglRenderer } from './app/gpuHelp';

const rootEl = document.getElementById('t2d-root') as HTMLElement;
const root = createRoot(rootEl);

function fatal(title: string, message: string, cause = '') {
  root.render(
    createElement('div', { className: 't2d-fatal', role: 'alert', 'data-t2d-fatal': cause || '1' }, createElement(EmptyState, null, createElement('strong', null, title), createElement('p', null, message))),
  );
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
    // Say what is off and where to turn it on (usually the browser's graphics acceleration).
    const help = gpuHelp(navigator.userAgent, webglRenderer());
    fatal(help.title, help.body, help.cause);
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

  // The view's colours, read on the page until the view is drawn (it reads them again on its stage).
  const canvas = document.createElement('canvas');
  const engine = new Engine(device, canvas, adapterName, viewPalette(document.documentElement));
  applyViewColours(engine, document.documentElement);
  store.onSceneChange = (s) => {
    saver.schedule(s);
    void engine.setScene(s);
  };
  await engine.setScene(loaded.scene);
  engine.start();
  // The sketcher: its solver (CAD's PlaneGCS worker) starts on the first sketch edited.
  let solver: SketchSolver | null = null;
  const editor = new SketchEditor(store, engine, () => (solver ??= new SketchSolver((url) => ws.spawnWorker(url))));
  const probes = new ProbeFeed(engine, store);
  probes.start();
  const sweeps = new SweepHost(engine, store);
  exposeTestHandle({ ws, store, engine, device, editor });
  window.addEventListener('pagehide', () => void saver.flush());

  root.render(createElement(App, { ws, store, engine, editor, probes, sweeps, units: ws.context.units, problem: loaded.problem }));
}

void main();
