// Start-up: connect to the host, create the services, mount the layout, start
// the kernel, load the document. Owner: INTEGRATE (scaffold version).
// SPDX-License-Identifier: GPL-3.0-or-later
import { connect } from '@magnusim/workspace';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createBridge } from '../lib/bridge';
import { createBus } from '../lib/bus';
import { createSelectionStore } from '../lib/selection';
import { createStateStore } from '../lib/store';
import { createDocService, install as installDoc } from '../doc';
import { PLUGIN_VERSION } from '../doc/schema';
import { createKernelAdapter } from '../kernel';
import type { AppServices } from '../types/app';
import type { Mode } from '../types/commands';
import type { CadEvents } from '../types/events';
import type { ViewportHandle } from '../types/viewport';
import { install as installUi } from '../ui';
import { install as installViewport } from '../viewport';
import { App } from './App';
import { createCommandRegistry } from './commands';
import { exposeTestHandle } from './debug';
import { bindCommandShortcuts, createKeyboard } from './keyboard';

function renderFatal(root: HTMLElement, title: string, message: string) {
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'cad-fatal';
  card.setAttribute('role', 'alert');
  card.setAttribute('data-cad-fatal', '1');
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  card.append(h, p);
  root.append(card);
}

export async function bootstrap(root: HTMLElement): Promise<AppServices | null> {
  const t0 = performance.now();
  let ws;
  try {
    ws = await connect({ timeoutMs: 15_000 });
  } catch (err) {
    renderFatal(root, 'The Part workspace could not start', `${err instanceof Error ? err.message : String(err)}. Open the Part from its project in Magnusim.`);
    return null;
  }

  const bridge = createBridge(ws);
  const bus = createBus<CadEvents>();
  const kernel = createKernelAdapter({ spawn: (url) => bridge.spawnWorker(url) });
  const doc = createDocService({ bridge, kernel, bus });
  let services: AppServices | null = null;
  const commands = createCommandRegistry(() => services!);
  const keyboard = createKeyboard(document);
  services = {
    bridge,
    bus,
    commands,
    keyboard,
    kernel,
    doc,
    selection: createSelectionStore(),
    mode: createStateStore<{ mode: Mode }>({ mode: 'model' }),
    viewport: createStateStore<{ handle: ViewportHandle | null }>({ handle: null }),
  };

  // Each area registers its commands and handlers (see ARCHITECTURE.md "install()").
  installDoc(services);
  installViewport(services);
  installUi(services);
  bindCommandShortcuts(commands, keyboard, (message) => bridge.toast(message, 'info'));
  exposeTestHandle(services, PLUGIN_VERSION);

  createRoot(root).render(createElement(App, { services }));

  // The kernel starts in the background; its chip shows progress and failures.
  kernel.start().catch(() => {});
  await doc.load();
  bus.emit('app:ready', { ms: performance.now() - t0 });
  return services;
}
