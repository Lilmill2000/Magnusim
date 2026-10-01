// The services every area gets (React: useServices() from src/lib/services.tsx).
// Created once by src/app/bootstrap.ts after connect().
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import type { EventBus } from '../lib/bus';
import type { CommandRegistry, KeyboardManager, Mode } from './commands';
import type { DocService } from './doc-service';
import type { CadEvents } from './events';
import type { KernelAdapter } from './kernel';
import type { Selection } from './selection';
import type { StateStore } from './state';
import type { ViewportHandle } from './viewport';

export interface AppServices {
  /** The host bridge (all ws.* calls go through it). */
  bridge: Bridge;
  bus: EventBus<CadEvents>;
  commands: CommandRegistry;
  keyboard: KeyboardManager;
  kernel: KernelAdapter;
  doc: DocService;
  /** Shared selection: the viewport and the tree both write it (src/lib/selection.ts helpers). */
  selection: StateStore<Selection>;
  /** 'model' now; 'sketch' when the sketcher lands (P3). */
  mode: StateStore<{ mode: Mode }>;
  /** Set by the viewport host (src/viewport) once it has mounted, null before and after unmount. Only the viewport writes it. */
  viewport: StateStore<{ handle: ViewportHandle | null }>;
}
