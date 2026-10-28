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
//       the arrows and the banana's guide);
//   D3  the light background is #f0f2f7 everywhere, the dark one the host's dark
//       --mg-viewport-bg #1b1f27 (E3: until Daniel says otherwise at the screenshot review).
// Still open for Daniel: E1, the edge colour on light faces, and E2, sketch lines over light
// faces. Each has three candidates (DARK_LINE_OPTIONS, DARK_INKS); darkPalette() takes the
// choice, and the test handle (window.__CAD__.appearance.darkLines) switches it live so all three
// can be shown. E2 is every coloured thin mark that can lie on a face: each state of a sketch's
// lines and points (both modes, the preview, guides and dimension lines too), the reference axes
// and points, the measure line, the Extrude and Enclosure arrows and the banana's guide (review
// round 1: it was only the fully defined lines, so an under-defined line on a face read 1.4:1 in
// every candidate). Until he picks, both are (c): the mid tones read on the background and on a
// light face alike. E4 (the triad's dark axis colours) is assumed yes; E5 keeps the region and
// plane tints. tests/viewport/palette.test.ts pins LIGHT to the core's light values,
// DARK's marks to at least 3:1 on its background, (c)'s on a body face too, and both palettes to
// the CSS tokens they mirror.
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

/**
 * E1 / E2 candidates for thin lines over light faces in a dark view: (a) the host's dark text
 * colour, plain; (b) the same with a 1 px rim in the background colour each side (one more line
 * drawn under each, sharing its geometry); (c) a mid grey that reads on both (5.3:1 on the
 * background, 1.85:1 on a body face). `color` is the edges' (E1) and a fully defined sketch
 * line's (E2); the other E2 colours are DARK_INKS'.
 */
export type DarkLineOption = 'a' | 'b' | 'c';
export interface DarkLines {
  /** E1: the bodies' B-rep edges. */
  edges: DarkLineOption;
  /**
   * E2: every coloured thin mark that can lie on a face (DARK_INKS): the sketch's lines and points
   * in every state, in sketch mode and model mode; (b)'s rim is under each of the sketch's.
   */
  sketch: DarkLineOption;
}
export const DARK_LINE_OPTIONS: Readonly<Record<DarkLineOption, { color: number; rim: boolean }>> = {
  a: { color: 0xe6e9ef, rim: false },
  b: { color: 0xe6e9ef, rim: true },
  c: { color: 0x8a93a3, rim: false },
};
/** Until Daniel picks E1 and E2 (screenshot review): (c) for both. */
export const DARK_LINES_DEFAULT: Readonly<DarkLines> = { edges: 'c', sketch: 'c' };

/** The E2 colours of a dark palette (all but the fully defined one, DARK_LINE_OPTIONS' colour). */
export interface DarkInks {
  readonly constructLine: number;
  readonly measure: number;
  readonly ink: number;
  readonly sketch: Readonly<Omit<SketchInk, 'fully' | 'dim' | 'pick' | 'hover' | 'grid' | 'gridMajor'>>;
}

/**
 * E2 by candidate. (a) and (b): the host's dark tokens (--mg-primary-ink, --mg-danger,
 * --mg-text-muted, --mg-warning, ...), light colours that read 5:1 and more on the background but
 * only 1.1 to 1.9:1 on a body face (#bdc9db); (b)'s rim gives them the background around them
 * there. (c): mid tones of the same hues, each about 3.2:1 on the background and 3:1 on a body
 * face (light's own inks read 2.7 to 3.9:1 on a face), and construction and driven lines a darker
 * grey than the fully defined mid grey (1.7:1 apart; dashed besides, for construction). The
 * arrows, the reference axes and points, the measure line and the banana's guide take the blue.
 */
export const DARK_INKS: Readonly<Record<DarkLineOption, DarkInks>> = (() => {
  const light: DarkInks = Object.freeze({
    constructLine: 0x7aa7ff,
    measure: 0x8fb5ff,
    ink: 0x7aa7ff,
    sketch: Object.freeze({ under: '#7aa7ff', over: '#f97066', construction: '#9aa4b2', preview: '#7aa7ff', driven: '#9aa4b2', doomed: '#f97066', linked: '#9b7bf0', lost: '#fdb022' }),
  });
  const mid: DarkInks = Object.freeze({
    constructLine: 0x2e6bd8,
    measure: 0x2e6bd8,
    ink: 0x2e6bd8,
    sketch: Object.freeze({ under: '#2e6bd8', over: '#cf3a30', construction: '#646d7e', preview: '#2e6bd8', driven: '#646d7e', doomed: '#cf3a30', linked: '#8551dc', lost: '#a85f12' }),
  });
  return Object.freeze({ a: light, b: light, c: mid });
})();

export interface MarkPalette {
  readonly name: 'light' | 'dark';
  /** The view's clear colour (LIGHT's also clears every picture). */
  readonly background: number;
  readonly edge: number;
  /** A rim drawn under each edge (E1 option b): its colour, or null for none. */
  readonly edgeRim: number | null;
  /** The orientation triad's X, Y and Z arrows. */
  readonly triad: readonly [number, number, number];
  /** Reference axes and points at rest (CONSTRUCT). */
  readonly constructLine: number;
  /** The measure line and its ends. */
  readonly measure: number;
  /** The primary blue as a mark: the Extrude and Enclosure arrows, the banana's snap guide. */
  readonly ink: number;
  readonly sketch: Readonly<SketchInk>;
  /** A rim drawn under each of the sketch's lines and points (E2 option b): its colour, or null for none. */
  readonly sketchRim: string | null;
  /** The E1 / E2 candidates this palette was made with (DARK only; null for LIGHT). */
  readonly lines: Readonly<DarkLines> | null;
}

/** The core's light colours: colors.ts' core values and the CSS tokens' light values. */
export const LIGHT: MarkPalette = Object.freeze({
  name: 'light',
  background: VIEWPORT_BG,
  edge: EDGE_COLOR,
  edgeRim: null,
  triad: TRIAD_COLORS,
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
  sketchRim: null,
  lines: null,
});

/** The dark background: the host's dark --mg-viewport-bg (E3). */
const DARK_BG = 0x1b1f27;

/**
 * The dark palette with these E1 / E2 candidates (DARK is it with the default): the edges' colour
 * and rim are E1's, every coloured thin mark E2's (DARK_LINE_OPTIONS, DARK_INKS); a pick and a
 * hover keep their colours (they read on both backgrounds), and so does the grid's subtlety.
 */
export function darkPalette(lines: Partial<DarkLines> = {}): MarkPalette {
  const chosen: DarkLines = { ...DARK_LINES_DEFAULT, ...lines };
  const edge = DARK_LINE_OPTIONS[chosen.edges];
  const sk = DARK_LINE_OPTIONS[chosen.sketch];
  const inks = DARK_INKS[chosen.sketch];
  const fully = hexString(sk.color);
  return Object.freeze({
    name: 'dark',
    background: DARK_BG,
    edge: edge.color,
    edgeRim: edge.rim ? DARK_BG : null,
    // E4: the host's dark axis colours (the light blue arrow reads only 2.99:1 on the dark background).
    triad: Object.freeze([0xff6b6b, 0x4cd07d, 0x6f9bff] as const),
    constructLine: inks.constructLine,
    measure: inks.measure,
    ink: inks.ink,
    sketch: Object.freeze({
      ...inks.sketch,
      fully,
      dim: fully,
      pick: LIGHT.sketch.pick,
      hover: LIGHT.sketch.hover,
      grid: '#2c323d',
      gridMajor: '#3a414e',
    }),
    sketchRim: sk.rim ? hexString(DARK_BG) : null,
    lines: Object.freeze({ ...chosen }),
  });
}

export const DARK: MarkPalette = darkPalette();

/** The palette of a theme name: anything but "dark" (any case) is light, as an older host is. */
export function paletteFor(theme: string | null | undefined, lines?: Partial<DarkLines>): MarkPalette {
  return typeof theme === 'string' && /^dark$/i.test(theme.trim()) ? (lines ? darkPalette(lines) : DARK) : LIGHT;
}

/** The view's palette now (a handle without palette(), as test fakes are, draws LIGHT). */
export function paletteOf(handle: { palette?: () => MarkPalette } | null | undefined): MarkPalette {
  return handle?.palette?.() ?? LIGHT;
}

/** Two palettes draw the same (the same object, or the same theme and candidates). */
export function samePalette(a: MarkPalette, b: MarkPalette): boolean {
  return a === b || (a.name === b.name && a.lines?.edges === b.lines?.edges && a.lines?.sketch === b.lines?.sketch);
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
