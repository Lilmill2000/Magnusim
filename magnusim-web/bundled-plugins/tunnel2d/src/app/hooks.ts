// Hooks that follow the host and the engine: the unit system, the page's theme, and the engine's changes.
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

/**
 * Runs `fn` after each change of the page's theme (html's data-theme, which the tokens follow);
 * returns a function that stops it. Colours read from the tokens once are read again then.
 * The workspace SDK is to set html's data-theme in the frame from the host's theme; until it
 * does, nothing sets it and the frame stays light.
 */
export function onAppearance(fn: () => void): () => void {
  const watch = new MutationObserver(() => fn());
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => watch.disconnect();
}

/** A count that goes up with each change of the page's theme: an effect that reads colours depends on it. */
export function useAppearance(): number {
  const [n, setN] = useState(0);
  useEffect(() => onAppearance(() => setN((v) => v + 1)), []);
  return n;
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
