// window.__CAD__: a read-mostly handle for e2e tests (never shown in the UI).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { ViewState } from '@magnusim/workspace';
import type { LinkController, LinkOutcome } from '../link/controller';
import type { AppServices } from '../types/app';

export interface CadTestHandle {
  version: string;
  services: AppServices;
  /**
   * LINK: the project-link controller. No control in the Part runs it (the sync
   * happens when the user leaves the workspace, host API 1.6); tests run it here.
   */
  link: LinkController | null;
  /** L3: the exit hook ('pending' until the app answered its registration), and its last run. */
  leave: CadLeaveHandle;
  /** A JSON-safe snapshot for Playwright's evaluate(). */
  snapshot(): {
    kernel: ReturnType<AppServices['kernel']['status']['get']>;
    doc: { status: string; features: number; bodies: number; save: string };
    viewport: boolean;
    selection: number;
  };
}

export interface CadLeaveHandle {
  hook: 'pending' | 'on' | 'unavailable';
  runs: number;
  last: { reason: string; outcome: LinkOutcome | null; view: ViewState | null; error: string | null } | null;
}

declare global {
  interface Window {
    __CAD__?: CadTestHandle;
  }
}

export function exposeTestHandle(services: AppServices, version: string, link: LinkController | null = null): CadLeaveHandle {
  const leave: CadLeaveHandle = { hook: 'pending', runs: 0, last: null };
  window.__CAD__ = {
    version,
    services,
    link,
    leave,
    snapshot() {
      const d = services.doc.state.get();
      return {
        kernel: services.kernel.status.get(),
        doc: { status: d.status, features: d.doc.features.length, bodies: d.rebuild.bodies.length, save: d.save.state },
        viewport: services.viewport.get().handle !== null,
        selection: services.selection.get().items.length,
      };
    },
  };
  return leave;
}
