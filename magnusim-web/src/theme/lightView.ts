/**
 * The 3D views' light colours as vtk.js takes them: the light values of their tokens (tokens.css),
 * for what is light whatever the theme (a capture's base: Daniel, 2026-10-27, files the person
 * keeps stay light) and for a view's first paint. A view then paints its background, lines, edges,
 * points and labels from the theme where it shows (runtime.js paintThemed), and its surfaces keep
 * these. lightView.test.ts holds each to its token's light value.
 */

/** Each 3D colour and its token, as the token's light value. */
export const LIGHT_VIEW = {
  /** --mg-viewport-bg: every 3D view's background and a capture's base. */
  bg: '#f0f2f7',
  /** --mg-viewport-ink: lines drawn over the model (Plot Over Path's path, vector arrows of iso surfaces). */
  ink: '#141a29',
  /** --mg-axis-x, -y, -z: the axes triad and the BC direction glyphs. */
  axisX: '#d42828',
  axisY: '#1f9a3a',
  axisZ: '#2a5bd7',
  /** --mg-bc-inlet, --mg-bc-outlet: the BC arrows, as the BC faces show them. */
  bcInlet: '#3884e6',
  bcOutlet: '#ea7024',
  /** --mg-pin: the Inspect markers, as the pin cards show them. */
  pin: '#c026d3',
} as const;

/** The token each LIGHT_VIEW colour is the light value of. */
export const LIGHT_VIEW_TOKENS: Readonly<Record<keyof typeof LIGHT_VIEW, string>> = {
  bg: '--mg-viewport-bg',
  ink: '--mg-viewport-ink',
  axisX: '--mg-axis-x',
  axisY: '--mg-axis-y',
  axisZ: '--mg-axis-z',
  bcInlet: '--mg-bc-inlet',
  bcOutlet: '--mg-bc-outlet',
  pin: '--mg-pin',
};

/** A #rrggbb colour as [r, g, b] from 0 to 255. */
export function hexRgb255(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A #rrggbb colour as [r, g, b] from 0 to 1 (vtk.js setColor, setBackground). */
export function hexRgb01(hex: string): [number, number, number] {
  return hexRgb255(hex).map((c) => c / 255) as [number, number, number];
}
