// The layout frame (proposal §3.1): toolbar row, then the full-bleed viewport
// with the tree column floating top-left and the status dock bottom-left. The
// host owns the 44 px header above the frame; this page never draws another.
// Owner: INTEGRATE (scaffold version).
// SPDX-License-Identifier: GPL-3.0-or-later
import { ServicesProvider } from '../lib/services';
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import { LeftStack, Overlays, StatusDock, Toolbar } from '../ui';
import { ViewportView } from '../viewport';

function Frame({ services }: { services: AppServices }) {
  const kernel = useStateStore(services.kernel.status, (s) => s.state);
  const doc = useStateStore(services.doc.state, (s) => s.status);
  const viewportReady = useStateStore(services.viewport, (s) => s.handle !== null);
  return (
    <div className="cad-app" data-cad-app="1" data-kernel={kernel} data-doc={doc} data-viewport={viewportReady ? 'ready' : 'none'}>
      <Toolbar />
      <div className="cad-stage">
        <ViewportView />
        <LeftStack />
        <StatusDock />
        <Overlays />
      </div>
    </div>
  );
}

export function App({ services }: { services: AppServices }) {
  return (
    <ServicesProvider services={services}>
      <Frame services={services} />
    </ServicesProvider>
  );
}
