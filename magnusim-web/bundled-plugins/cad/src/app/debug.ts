// window.__CAD__: a read-mostly handle for e2e tests (never shown in the UI).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';

export interface CadTestHandle {
  version: string;
  services: AppServices;
  /** A JSON-safe snapshot for Playwright's evaluate(). */
  snapshot(): {
    kernel: ReturnType<AppServices['kernel']['status']['get']>;
    doc: { status: string; features: number; bodies: number; save: string };
    viewport: boolean;
    selection: number;
  };
}

declare global {
  interface Window {
    __CAD__?: CadTestHandle;
  }
}

export function exposeTestHandle(services: AppServices, version: string): void {
  window.__CAD__ = {
    version,
    services,
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
}
