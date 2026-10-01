// React host of the viewport: creates it on mount (bound to the app's
// services), publishes the handle as services.viewport, renders its chrome
// (the bottom-right cluster: selection filter, section, views, Fit, XYZ key,
// triad slot) and disposes it on unmount. Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../lib/services';
import type { ViewportHandle } from '../types/viewport';
import { ViewportChrome } from './ViewportChrome';
import { createViewport } from './viewport';

export function ViewportView() {
  const services = useServices();
  const host = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<ViewportHandle | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const h = createViewport(el, { services });
    services.viewport.set({ handle: h });
    setHandle(h);
    return () => {
      services.viewport.set({ handle: null });
      setHandle(null);
      h.dispose();
    };
  }, [services]);
  return (
    <div ref={host} className="cad-viewport" data-cad-viewport="1">
      {handle ? <ViewportChrome handle={handle} /> : null}
    </div>
  );
}
