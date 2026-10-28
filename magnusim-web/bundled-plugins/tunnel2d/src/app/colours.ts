// The view's colours, from the design tokens: the engine's palette, the rheoscopic tank's looks,
// the particles view's bodies and the flow markers, the marks drawn over the view, and the cards
// on pictures and recordings. The GPU draws the view in its light colours in every theme, and what
// a person keeps (a picture, a recording) is light too, marks and cards included (Daniel,
// 2026-10-27): all of these are read on a hidden element with data-theme="light", never on the
// page. Each set is read once the page's stylesheets are in, and again after the host's 'theme'
// event (forgetColours).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Palette } from '../render/renderer';
import type { Engine } from '../sim/engine';
import type { Palette as SketchPalette } from '../sketch/editor';
import type { OverlayColours } from '../ui/overlay';

export type Theme = 'light' | 'dark';

/** A CSS colour (a design token) as linear 0..1 RGB, read on `scope`. */
export function tokenRgb(name: string, scope: Element): [number, number, number] {
  const v = getComputedStyle(scope).getPropertyValue(name).trim();
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = v || 'black';
  const hex = c.fillStyle as string;
  if (hex.startsWith('#')) return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
  const m = /rgba?\(([^)]+)\)/.exec(hex);
  const p = m ? m[1].split(',').map(Number) : [0, 0, 0];
  return [p[0] / 255, p[1] / 255, p[2] / 255];
}

const scopes = new Map<Theme, HTMLElement>();

/**
 * A hidden element with a theme of its own: the tokens read on it are that theme's whatever the
 * page's (tokens.css declares the tunnel's again on it). data-theme-keep says it keeps its theme on
 * purpose, as the core marks its own.
 */
export function themeScope(theme: Theme): HTMLElement {
  let el = scopes.get(theme);
  if (!el?.isConnected) {
    el = document.createElement('div');
    el.hidden = true;
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-theme', theme);
    el.setAttribute('data-theme-keep', '');
    document.body.appendChild(el);
    scopes.set(theme, el);
  }
  return el;
}

const sets = new Map<string, unknown>();

/** A colour set read on `scope`, kept once the stylesheets are in (--t2d-bg has a value). */
function kept<T>(key: string, scope: Element, read: (read: (name: string) => string) => T): T {
  const had = sets.get(key) as T | undefined;
  if (had) return had;
  const css = getComputedStyle(scope);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const set = read(token);
  if (token('--t2d-bg')) sets.set(key, set);
  return set;
}

/** The host's stylesheet changed: every set is read again at its next use. */
export function forgetColours() {
  sets.clear();
}

/** The engine's palette: the view's background, bodies, absorbing zones, plain background and arrows. */
export function viewPalette(scope: Element): Palette {
  return {
    bg: tokenRgb('--t2d-bg', scope),
    body: tokenRgb('--t2d-body', scope),
    edge: tokenRgb('--t2d-edge', scope),
    zone: [...tokenRgb('--t2d-zone', scope), 0.14],
    plain: tokenRgb('--t2d-plain', scope),
    arrow: [...tokenRgb('--t2d-arrow', scope), 0.85],
  };
}

/** Sets every colour the engine draws with from the tokens on `scope` (the light one: themeScope('light')). */
export function applyViewColours(engine: Engine, scope: Element) {
  const rgb = (name: string) => tokenRgb(name, scope);
  engine.palette = viewPalette(scope);
  // Two lights 25 degrees over the tank, from the upper left and the lower right.
  const lightDir = (azDeg: number): [number, number, number] => {
    const el = (16 * Math.PI) / 180;
    const az = (azDeg * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  };
  const look = (name: string, d1: number, d2: number, sharp: number, glint: number) => ({
    base: rgb(`--t2d-rheo-${name}-base`),
    l1: { dir: lightDir(135), color: rgb(`--t2d-rheo-${name}-light1`), diffuse: d1 },
    l2: { dir: lightDir(-45), color: rgb(`--t2d-rheo-${name}-light2`), diffuse: d2 },
    sharp,
    glint,
  });
  engine.rheoLooks = { kalliroscope: look('kalliroscope', 0.16, 0.12, 12, 1.8), pearl: look('pearl', 0.18, 0.14, 12, 1.6), copper: look('copper', 0.17, 0.12, 10, 1.8) };
  engine.bodyLook = { body: rgb('--t2d-body-dark'), edge: rgb('--t2d-edge-light') };
  engine.markerColors = {
    tracerDark: [...rgb('--t2d-particle-dark'), 0.5],
    tracerLight: [...rgb('--t2d-particle-light'), 0.85],
    rakes: [1, 2, 3, 4, 5, 6].map((i) => [...rgb(`--t2d-rake-${i}`), 0.85] as [number, number, number, number]),
    // On the dark views: each rake colour a third of the way to white.
    rakesOnDark: [1, 2, 3, 4, 5, 6].map((i) => {
      const c = rgb(`--t2d-rake-${i}`);
      return [c[0] + (1 - c[0]) * 0.35, c[1] + (1 - c[1]) * 0.35, c[2] + (1 - c[2]) * 0.35, 0.85] as [number, number, number, number];
    }),
    streamline: [...rgb('--t2d-streamline'), 0.4],
    streamlineLight: [...rgb('--t2d-particle-light'), 0.35],
  };
}

/** The sketch's colours, from the tokens (as CAD's sketch: blue under-defined, ink fully, red over). */
export function sketchPalette(read: (name: string) => string): SketchPalette {
  const v = (name: string, fallback: string) => read(name) || fallback;
  return {
    under: v('--t2d-sketch-under', 'blue'),
    fully: v('--t2d-sketch-full', 'black'),
    over: v('--t2d-sketch-over', 'red'),
    construction: v('--t2d-sketch-construction', 'gray'),
    pick: v('--t2d-sketch-pick', 'green'),
    halo: v('--t2d-sketch-halo', 'white'),
    preview: v('--t2d-sketch-preview', 'blue'),
  };
}

/** The overlay's colours, from the tokens as `read` gives them (a token's value, trimmed). */
export function overlayColours(read: (name: string) => string): OverlayColours {
  const sel = read('--t2d-select') || 'black';
  return {
    sel,
    selInk: read('--t2d-select-ink') || sel,
    ghost: read('--t2d-ghost') || 'gray',
    halo: read('--t2d-halo') || 'white',
    probe: read('--t2d-probe') || 'black',
    rakes: [1, 2, 3, 4, 5, 6].map((i) => read(`--t2d-rake-${i}`)),
    sketch: sketchPalette(read),
  };
}

/** The overlay's colours in a theme: the page's on screen, light in pictures and recordings. */
export function overlaySet(theme: Theme): OverlayColours {
  return kept(`overlay:${theme}`, themeScope(theme), overlayColours);
}

/** The legend and caption cards on pictures and recordings: the light page's background and text. */
export function captureCards(): { bg: string; ink: string } {
  return kept('cards', themeScope('light'), (read) => ({ bg: read('--mg-bg') || 'white', ink: read('--mg-text') || 'black' }));
}
