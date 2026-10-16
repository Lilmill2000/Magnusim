// Hooks that follow the host and the engine: the unit system, and the engine's changes.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { UnitSystem } from '@magnusim/plugin-ui';
import { useEffect, useState } from 'react';

/** The host's unit system, following its changes. */
export function useWorkspaceUnits(ws: { on(event: 'units', fn: (u: UnitSystem) => void): () => void; context: { units: UnitSystem } }, initial: UnitSystem): UnitSystem {
  const [units, setUnits] = useState<UnitSystem>(initial);
  useEffect(() => {
    const off = ws.on('units', setUnits);
    // A change that came while the page mounted (before this listened) is in the context already.
    setUnits(ws.context.units);
    return off;
  }, [ws]);
  return units;
}

/** Draw again on every change the engine announces. */
export function useEngineTick(engine: { subscribe(fn: () => void): () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const off = engine.subscribe(() => tick((n) => n + 1));
    // What changed between the render and this subscription is drawn now.
    tick((n) => n + 1);
    return off;
  }, [engine]);
}
