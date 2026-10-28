// The colours the 3D view and the sketch draw in, by theme: the one place three.js code takes
// them from (three.js needs numbers; the HTML over the view follows the CSS tokens). LIGHT is
// the core's light values, the look the view had before the dark set (its triad the host's light
// axis colours, as the core's since its light unify); DARK is for the host's dark appearance
// (owner decisions, "CAD dark set" plan):
//   D1  pictures, previews and exports stay LIGHT whatever the theme (ViewportHandle.snapshot
//       swaps every mark to LIGHT for the picture and back in the same task);
//   D2  surfaces stay light in a dark view: bodies, section caps, picks and hover on faces, the
//       plane and region tints are the same in both (colors.ts); only thin marks turn light
//       (edges, the triad, sketch lines and points, reference axes and points, the measure line,
//       the arrows and the banana's guide), and those that can lie on a face only over the
//       background (E1, E2);
//   D3  the light background is #f0f2f7 everywhere, the dark one the host's dark
//       --mg-viewport-bg #1b1f27;
//   E1  (Daniel, 2026-10-28) the bodies' B-rep edges follow what is under them as E2's marks do:
//       LIGHT's near-black where a light surface shows under them, the host's dark text colour
//       #e6e9ef over the background (`edge`; no rim). His first pick, #e6e9ef everywhere, lost
//       the edges on a face seen head-on (it lights to #dbe9fe: 1.06:1), as when sketching on it;
//   E2  (Daniel, 2026-10-28: "the colour follows what's under it") every coloured thin mark that
//       can lie on a face (each state of a sketch's lines and points in both modes, the preview,
//       guides, dimension lines and grid, a trim's doomed piece, linked and lost curves; the
//       reference axes and points; the measure line and its ends; the Extrude and Enclosure
//       arrows; the banana's guide) is drawn, pixel by pixel, in LIGHT's colour for its role
//       (`face`, by role: the light view's dark inks) where a light surface (an opaque body face,
//       a section cap) is what shows under it, and in DARK's own light inks over the background
//       or an empty or translucent plane. A line that crosses a face's outline changes colour
//       there (accepted). A pick and a hover keep their colours (they read on both). How it is
//       drawn: src/viewport/onface.ts (one stencil bit for "a light surface shows here");
//   E4  the triad takes the host's dark axis colours, lit with some ambient (`triadLight`: lit by
//       the headlight alone, as the core's vtkAxesActor, an arrow pointing at the eye shows only
//       its cone's sides, at 45 % of its colour: 1.8:1 on the dark background); E5 keeps the
//       region and plane tints.
// In LIGHT nothing follows what is under it (`face` null): the light view is as it was.
// tests/viewport/palette.test.ts pins LIGHT to the core's light values, DARK's marks to at least
// 3:1 on its background, its face inks to LIGHT's by role, and both palettes to the CSS tokens
// they mirror.
// Owner: VIEWPORT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { EDGE_COLOR, HOVER_COLOR, PICK_COLOR, TRIAD_COLORS, VIEWPORT_BG } from './colors';

/** A sketch's colours by role, '#rrggbb' (the sketch overlay's lines and points take CSS colour strings). */
export interface SketchInk {
  /** Under defined; a tool's preview and an inference guide (`preview`). */
  under: string;
  fully: string;
  over: string;
  construction: string;
  pick: string;
  hover: string;
  preview: string;
  /** A driving dimension's lines; a driven one's (`driven`). */
  dim: string;
  driven: string;
  grid: string;
  gridMajor: string;
  /** A trim's piece about to go. */
  doomed: string;
  /** P4b SELECT: linked geometry (projected, intersection) and a lost reference. */
  linked: string;
  lost: string;
}

/** How the triad's arrows are lit: ambient + diffuse * the headlight's angle (materials.ts' body shading). */
export interface TriadLight {
  readonly ambient: number;
  readonly diffuse: number;
}

/** The thin marks' colours by role where a light surface shows under them (E1, E2): LIGHT's. */
export interface FaceInks {
  /** The bodies' B-rep edges (E1). */
  readonly edge: number;
  readonly constructLine: number;
  readonly measure: number;
  readonly ink: number;
  readonly sketch: Readonly<SketchInk>;
}

export interface MarkPalette {
  readonly name: 'light' | 'dark';
  /** The view's clear colour (LIGHT's also clears every picture). */
  readonly background: number;
  readonly edge: number;
  /** The orientation triad's X, Y and Z arrows. */
  readonly triad: readonly [number, number, number];
  /** How the triad is lit (LIGHT: the core's vtkAxesActor, ambient 0 and diffuse 1). */
  readonly triadLight: TriadLight;
  /** Reference axes and points at rest (CONSTRUCT). */
  readonly constructLine: number;
  /** The measure line and its ends. */
  readonly measure: number;
  /** The primary blue as a mark: the Extrude and Enclosure arrows, the banana's snap guide. */
  readonly ink: number;
  readonly sketch: Readonly<SketchInk>;
  /**
   * E2: each mark's colour, by role, where a light surface shows under it (LIGHT's), or null when
   * it is the same as above (LIGHT: nothing is drawn twice).
   */
  readonly face: FaceInks | null;
}

/** The core's light colours: colors.ts' core values and the CSS tokens' light values. */
export const LIGHT: MarkPalette = Object.freeze({
  name: 'light',
  background: VIEWPORT_BG,
  edge: EDGE_COLOR,
  triad: TRIAD_COLORS,
  // vtkAxesActor's mapper defaults (runtime.js:1386), as the core's triad.
  triadLight: Object.freeze({ ambient: 0, diffuse: 1 }),
  constructLine: 0x2f5fb8,
  measure: 0x1a4fbf,
  ink: 0x1570ef,
  sketch: Object.freeze({
    under: '#1570ef',
    fully: '#101828',
    over: '#b42318',
    construction: '#667085',
    pick: hexString(PICK_COLOR),
    hover: hexString(HOVER_COLOR),
    preview: '#1570ef',
    dim: '#101828',
    driven: '#667085',
    grid: '#e8ebf0',
    gridMajor: '#cfd3db',
    doomed: '#b42318',
    linked: '#7a3fd1',
    lost: '#b54708',
  }),
  face: null,
});

/** The dark background: the host's dark --mg-viewport-bg (D3). */
const DARK_BG = 0x1b1f27;
/** E1 (a), and a fully defined sketch line over the background: the host's dark --mg-text. */
const DARK_TEXT = '#e6e9ef';

/**
 * The dark palette. Its own inks are the host's dark tokens (--mg-text, --mg-primary-ink,
 * --mg-danger, --mg-text-muted, --mg-warning, --mg-link, ...): light colours that read 5:1 and
 * more on the background. Over a light surface each mark takes `face`, LIGHT's ink for its role
 * (E2). A pick and a hover keep their colours, and the grid its subtlety.
 */
export const DARK: MarkPalette = Object.freeze({
  name: 'dark',
  background: DARK_BG,
  edge: hexNumber(DARK_TEXT),
  // E4: the host's dark axis colours (the light blue arrow reads only 2.99:1 on the dark background).
  triad: Object.freeze([0xff6b6b, 0x4cd07d, 0x6f9bff] as const),
  // An arrow seen end on, pointing at the eye, at 75 % of its colour (its cone's sides face the
  // headlight at 63 deg): 3.5:1 and more; one facing the light keeps its full colour.
  triadLight: Object.freeze({ ambient: 0.55, diffuse: 0.45 }),
  constructLine: 0x7aa7ff,
  measure: 0x8fb5ff,
  ink: 0x7aa7ff,
  sketch: Object.freeze({
    under: '#7aa7ff',
    fully: DARK_TEXT,
    over: '#f97066',
    construction: '#9aa4b2',
    pick: LIGHT.sketch.pick,
    hover: LIGHT.sketch.hover,
    preview: '#7aa7ff',
    dim: DARK_TEXT,
    driven: '#9aa4b2',
    grid: '#2c323d',
    gridMajor: '#3a414e',
    doomed: '#f97066',
    linked: '#9b7bf0',
    lost: '#fdb022',
  }),
  face: Object.freeze({ edge: LIGHT.edge, constructLine: LIGHT.constructLine, measure: LIGHT.measure, ink: LIGHT.ink, sketch: LIGHT.sketch }),
});

/** The palette of a theme name: anything but "dark" (any case) is light, as an older host is. */
export function paletteFor(theme: string | null | undefined): MarkPalette {
  return typeof theme === 'string' && /^dark$/i.test(theme.trim()) ? DARK : LIGHT;
}

/** The view's palette now (a handle without palette(), as test fakes are, draws LIGHT). */
export function paletteOf(handle: { palette?: () => MarkPalette } | null | undefined): MarkPalette {
  return handle?.palette?.() ?? LIGHT;
}

/** Two palettes draw the same (the same object, or the same theme). */
export function samePalette(a: MarkPalette, b: MarkPalette): boolean {
  return a === b || a.name === b.name;
}

const SKETCH_ROLES = ['under', 'fully', 'over', 'construction', 'pick', 'hover', 'preview', 'dim', 'driven', 'grid', 'gridMajor', 'doomed', 'linked', 'lost'] as const satisfies readonly (keyof SketchInk)[];

/**
 * Each of a palette's sketch inks ('#rrggbb', lower case) to its face ink: the sketch's lines and
 * points carry a colour per segment or point, so their twin over a light face maps colours, not
 * roles. One dark ink is never two roles with different face inks (tests/viewport/palette.test.ts).
 */
const faceMaps = new WeakMap<MarkPalette, Map<string, string>>();
function faceMapOf(p: MarkPalette): Map<string, string> | null {
  if (!p.face) return null;
  let m = faceMaps.get(p);
  if (!m) {
    m = new Map();
    for (const role of SKETCH_ROLES) m.set(p.sketch[role].toLowerCase(), p.face.sketch[role]);
    faceMaps.set(p, m);
  }
  return m;
}

/** A sketch ink of this palette over a light surface: its role's face ink (itself in LIGHT, or for a colour the palette does not have). */
export function faceSketchInk(p: MarkPalette, ink: string): string {
  return faceMapOf(p)?.get(ink.toLowerCase()) ?? ink;
}

/** The roles a sketch ink is in a palette (tests: one face ink per dark ink). */
export function sketchRolesOf(p: MarkPalette, ink: string): (keyof SketchInk)[] {
  return SKETCH_ROLES.filter((r) => p.sketch[r].toLowerCase() === ink.toLowerCase());
}

/** 0xrrggbb -> '#rrggbb'. */
export function hexString(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** '#rrggbb' -> 0xrrggbb (a sketch ink as a three.js colour number). */
export function hexNumber(s: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${s}`);
  return parseInt(m[1], 16);
}
