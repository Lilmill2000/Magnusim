// The host's appearance applied to the Part, in one handler, at the start and on every change:
//   - the 3D view's palette (src/viewport/palette.ts): DARK with the dark theme, LIGHT otherwise,
//     on the view now and on every view made later (pictures stay light whatever it is);
//   - the keys to the sketch's line colours (--cad-sketch-key-*: the Sketch panel's state dot, a
//     reference's dot) set on <html> from that palette while it is dark, so a key shows the colour
//     the lines are drawn in whatever E2's candidate; taken away in light (the stylesheet's own);
//   - the toolbar's size from the icon scale (--cad-toolbar-scale, Toolbar.tsx setToolbarScale);
//     the ribbon's names follow the text scale through the host's --mg-text-* tokens.
// The page's CSS needs nothing from here: the host's SDK writes data-theme, color-scheme and the
// scales on <html> (CAD never sets them), and CAD's tokens follow (src/styles/tokens.css). A host
// without an appearance (Bridge.appearance: LIGHT_APPEARANCE) changes nothing: the Part is light.
// Also E1 / E2, the candidates the dark view draws edges and sketch lines with, until Daniel picks
// (window.__CAD__.appearance.darkLines, for his screenshot review).
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Appearance } from '../lib/bridge';
import type { AppServices } from '../types/app';
import { setToolbarScale } from '../ui/Toolbar';
import { DARK_LINES_DEFAULT, paletteFor, type DarkLineOption, type DarkLines, type MarkPalette, type SketchInk } from '../viewport/palette';

/** The CSS keys to the sketch's line colours, by the palette ink each shows (src/styles/tokens.css). */
export const SKETCH_KEYS: Readonly<Record<string, keyof SketchInk>> = Object.freeze({
  '--cad-sketch-key-under': 'under',
  '--cad-sketch-key-full': 'fully',
  '--cad-sketch-key-over': 'over',
  '--cad-sketch-key-linked': 'linked',
  '--cad-sketch-key-lost': 'lost',
});

/**
 * The keys on <html> for a palette: a dark one's inks (E2's candidate), none for LIGHT (the
 * stylesheet's light values, which are LIGHT's inks: nothing changes in light).
 */
export function setSketchKeys(p: MarkPalette, root: HTMLElement = document.documentElement): void {
  for (const [name, ink] of Object.entries(SKETCH_KEYS)) {
    if (p.name === 'dark') root.style.setProperty(name, p.sketch[ink]);
    else root.style.removeProperty(name);
  }
}

export interface AppearanceControl {
  /** The host's appearance as the Part has it now. */
  appearance(): Appearance;
  /** The palette the 3D view is given now. */
  palette(): MarkPalette;
  /**
   * E1 / E2 (Daniel's screenshot review): the candidates the dark view draws edges and sketch
   * lines with: one option for both, or each apart. Applied at once while the view is dark, kept
   * for when it turns dark. Returns the choice now.
   */
  darkLines(lines?: Partial<DarkLines> | DarkLineOption): DarkLines;
  dispose(): void;
}

export function installAppearance(services: AppServices): AppearanceControl {
  const { bridge } = services;
  let lines: DarkLines = { ...DARK_LINES_DEFAULT };
  // The icon scale given to the toolbar (1: --cad-toolbar-scale as tokens.css has it).
  let iconScale = 1;
  const palette = () => paletteFor(bridge.theme(), lines);
  const toView = () => {
    const p = palette();
    services.viewport.get().handle?.setPalette?.(p);
    setSketchKeys(p);
  };
  const apply = () => {
    toView();
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
    darkLines(next) {
      const ok = (o: unknown): o is DarkLineOption => o === 'a' || o === 'b' || o === 'c';
      if (typeof next === 'string' && ok(next)) lines = { edges: next, sketch: next };
      else if (next && typeof next === 'object') lines = { edges: ok(next.edges) ? next.edges : lines.edges, sketch: ok(next.sketch) ? next.sketch : lines.sketch };
      if (next !== undefined) toView();
      return { ...lines };
    },
    dispose() {
      offAppearance();
      offViewport();
    },
  };
}
