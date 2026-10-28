// The colours the 3D view and the sketch draw in, by theme: the one place three.js code takes
// them from (three.js needs numbers; the HTML over the view follows the CSS tokens). LIGHT is
// exactly the look the view always had; DARK is for the host's dark appearance (owner decisions,
// "CAD dark set" plan):
//   D1  pictures, previews and exports stay LIGHT whatever the theme (ViewportHandle.snapshot
//       swaps every mark to LIGHT for the picture and back in the same task);
//   D2  surfaces stay light in a dark view: bodies, section caps, picks and hover on faces, the
//       plane and region tints are the same in both (colors.ts); only thin marks turn light
//       (edges, the triad, sketch lines and points, reference axes and points, the measure line,
//       the arrows and the banana's guide);
//   D3  the light background is #f0f2f7 everywhere, the dark one the host's dark
//       --mg-viewport-bg #1b1f27 (E3: until Daniel says otherwise at the screenshot review).
// Still open for Daniel: E1, the edge colour on light faces, and E2, sketch lines over light
// faces. Each has three candidates (DARK_LINE_OPTIONS); darkPalette() takes the choice, and the
// test handle (window.__CAD__.appearance.darkLines) switches it live so all three can be shown.
// Until he picks, both are (c), the mid grey: it reads on the background and on light faces.
// E4 (the triad's dark axis colours) is assumed yes; E5 keeps the region and plane tints.
// tests/viewport/palette.test.ts pins LIGHT to the values before the dark set, DARK's marks to
// at least 3:1 on its background, and both to the CSS tokens they mirror.
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
 * background, 1.85:1 on a body face).
 */
export type DarkLineOption = 'a' | 'b' | 'c';
export interface DarkLines {
  /** E1: the bodies' B-rep edges. */
  edges: DarkLineOption;
  /** E2: sketch lines and points (the fully defined ones, the origin and the dimension lines; the rim under every sketch line). */
  sketch: DarkLineOption;
}
export const DARK_LINE_OPTIONS: Readonly<Record<DarkLineOption, { color: number; rim: boolean }>> = {
  a: { color: 0xe6e9ef, rim: false },
  b: { color: 0xe6e9ef, rim: true },
  c: { color: 0x8a93a3, rim: false },
};
/** Until Daniel picks E1 and E2 (screenshot review): (c) for both. */
export const DARK_LINES_DEFAULT: Readonly<DarkLines> = { edges: 'c', sketch: 'c' };

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
  /** A rim drawn under each sketch line (E2 option b): its colour, or null for none. */
  readonly sketchRim: string | null;
  /** The E1 / E2 candidates this palette was made with (DARK only; null for LIGHT). */
  readonly lines: Readonly<DarkLines> | null;
}

/** Exactly the colours before the dark set: colors.ts' core values and the CSS tokens' light values. */
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
 * The dark palette with these E1 / E2 candidates (DARK is it with the default). Its blues and
 * reds are the host's dark tokens (--mg-primary-ink, --mg-primary-strong, --mg-danger, ...); a
 * pick and a hover keep their colours (they read on both backgrounds).
 */
export function darkPalette(lines: Partial<DarkLines> = {}): MarkPalette {
  const chosen: DarkLines = { ...DARK_LINES_DEFAULT, ...lines };
  const edge = DARK_LINE_OPTIONS[chosen.edges];
  const sk = DARK_LINE_OPTIONS[chosen.sketch];
  const ink = hexString(sk.color);
  return Object.freeze({
    name: 'dark',
    background: DARK_BG,
    edge: edge.color,
    edgeRim: edge.rim ? DARK_BG : null,
    // E4: the host's dark axis colours (the light blue arrow reads only 2.99:1 on the dark background).
    triad: Object.freeze([0xff6b6b, 0x4cd07d, 0x6f9bff] as const),
    constructLine: 0x7aa7ff,
    measure: 0x8fb5ff,
    ink: 0x7aa7ff,
    sketch: Object.freeze({
      under: '#7aa7ff',
      fully: ink,
      over: '#f97066',
      construction: '#9aa4b2',
      pick: LIGHT.sketch.pick,
      hover: LIGHT.sketch.hover,
      preview: '#7aa7ff',
      dim: ink,
      driven: '#9aa4b2',
      grid: '#2c323d',
      gridMajor: '#3a414e',
      doomed: '#f97066',
      linked: '#9b7bf0',
      lost: '#fdb022',
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
