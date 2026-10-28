// The host's appearance (unreleased 1.9) applied to the Part, in one handler, at the start (the
// welcome's look) and on every change:
//   - the 3D view's palette (src/viewport/palette.ts): DARK with the dark theme, LIGHT otherwise,
//     on the view now and on every view made later, from its first frame (pictures stay light
//     whatever it is);
//   - the toolbar's size from the icon scale (--cad-toolbar-scale, Toolbar.tsx setToolbarScale);
//     the ribbon's names follow the text scale through the host's --mg-text-* tokens.
// The page's CSS needs nothing from here: the host's SDK writes data-theme and the scales on
// <html> (CAD never sets them; the page has them from its first paint, and theme.css takes
// color-scheme from data-theme), and CAD's tokens follow (src/styles/tokens.css; the keys to the
// sketch's line colours there are the palettes' inks, tests/viewport/palette.test.ts). A host
// without an appearance (Bridge.appearance: LIGHT_APPEARANCE) changes nothing: the Part is light.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Appearance } from '../lib/bridge';
import type { AppServices } from '../types/app';
import { setToolbarScale } from '../ui/Toolbar';
import { paletteFor, type MarkPalette } from '../viewport/palette';

export interface AppearanceControl {
  /** The host's appearance as the Part has it now. */
  appearance(): Appearance;
  /** The palette the 3D view is given now. */
  palette(): MarkPalette;
  dispose(): void;
}

export function installAppearance(services: AppServices): AppearanceControl {
  const { bridge } = services;
  // The icon scale given to the toolbar (1: --cad-toolbar-scale as tokens.css has it).
  let iconScale = 1;
  const palette = () => paletteFor(bridge.theme());
  const apply = () => {
    services.viewport.get().handle?.setPalette?.(palette());
    const s = bridge.appearance().iconScale;
    if (s !== iconScale) {
      iconScale = s;
      // Scale 1 takes the property away again (the stylesheet's own 1).
      setToolbarScale(s === 1 ? Number.NaN : s);
    }
  };
  const offAppearance = bridge.onAppearance(apply);
  // A view made later (the Part's layout mounts it) starts in the palette, before its first frame.
  const offViewport = services.viewport.subscribe((s, prev) => {
    if (s.handle && s.handle !== prev.handle) s.handle.setPalette?.(palette());
  });
  apply();
  return {
    appearance: () => bridge.appearance(),
    palette,
    dispose() {
      offAppearance();
      offViewport();
    },
  };
}
