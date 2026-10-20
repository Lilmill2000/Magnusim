// The services every area gets (React: useServices() from src/lib/services.tsx).
// Created once by src/app/bootstrap.ts after connect().
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import type { EventBus } from '../lib/bus';
import type { AssistantPageApi } from './assistant';
import type { CommandRegistry, KeyboardManager, Mode } from './commands';
import type { DocService } from './doc-service';
import type { CadEvents } from './events';
import type { FileTransfer } from './files';
import type { KernelAdapter } from './kernel';
import type { LinkController } from '../link/controller';
import type { ModuleRegistry } from './modules';
import type { Selection } from './selection';
import type { SketchModeApi, SketchSolverClient } from './sketch';
import type { StateStore } from './state';
import type { ViewportHandle } from './viewport';

/**
 * APIs one area publishes for the others, set by that area's module install()
 * (null until then, and in tests that do not install it). One writer each:
 * `sketch` and `solver` P3-SKETCH, `files` P2-FEATURES.
 */
export interface AreaApis {
  sketch: SketchModeApi | null;
  solver: SketchSolverClient | null;
  files: FileTransfer | null;
  /** The Assistant's page API (one writer: ASSISTANT). Optional, so it is absent where nothing installs it. */
  assistant?: AssistantPageApi | null;
  /** LINK: the project-link controller (save, then link: what the app's Back runs), set by bootstrap; absent in tests that make none. */
  link?: LinkController | null;
}

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
  /** 'model', or 'sketch' while a sketch is edited (written only by sketch mode, src/sketch/). */
  mode: StateStore<{ mode: Mode }>;
  /** Set by the viewport host (src/viewport) once it has mounted, null before and after unmount. Only the viewport writes it. */
  viewport: StateStore<{ handle: ViewportHandle | null }>;
  /** The modules found at start-up (src/modules.ts): their panels and tools. */
  modules: ModuleRegistry;
  /** Cross-area APIs (see AreaApis). */
  apis: StateStore<AreaApis>;
}
