/**
 * Results colour maps: 256 entries of 8-bit RGB each, the tables a render
 * hands to its lookup table and a legend draws. Rainbow is the app's own
 * (generated, as vtk.js builds it); viridis, balance and curl are stored in
 * data.ts with their sources and licences.
 */
import { BALANCE_HEX, CURL_HEX, VIRIDIS_HEX } from './data';

export type ColormapName = 'rainbow' | 'viridis' | 'balance' | 'curl';

/** Every colour map, in the order a picker lists them. */
export const COLORMAPS: readonly ColormapName[] = Object.freeze(['rainbow', 'viridis', 'balance', 'curl'] as ColormapName[]);

/** The rainbow's starting hue (blue); it runs to 0 (red). Every rainbow table in the app reads it. */
export const RAINBOW_HUE = 0.667;

const SIZE = 256;

/** vtk.js's hsv2rgb (Common/Core/Math), so the table equals a vtkLookupTable's byte for byte. */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const onethird = 1.0 / 3.0;
  const onesixth = 1.0 / 6.0;
  const twothird = 2.0 / 3.0;
  const fivesixth = 5.0 / 6.0;
  let r: number;
  let g: number;
  let b: number;
  if (h > onesixth && h <= onethird) {
    g = 1.0;
    r = (onethird - h) / onesixth;
    b = 0.0;
  } else if (h > onethird && h <= 0.5) {
    g = 1.0;
    b = (h - onethird) / onesixth;
    r = 0.0;
  } else if (h > 0.5 && h <= twothird) {
    b = 1.0;
    g = (twothird - h) / onesixth;
    r = 0.0;
  } else if (h > twothird && h <= fivesixth) {
    b = 1.0;
    r = (h - twothird) / onesixth;
    g = 0.0;
  } else if (h > fivesixth && h <= 1.0) {
    r = 1.0;
    b = (1.0 - h) / onesixth;
    g = 0.0;
  } else {
    r = 1.0;
    g = h / onesixth;
    b = 0.0;
  }
  r = (s * r + (1.0 - s)) * v;
  g = (s * g + (1.0 - s)) * v;
  b = (s * b + (1.0 - s)) * v;
  return [r, g, b];
}

/** The rainbow as vtkLookupTable builds it: hue RAINBOW_HUE to 0, saturation and value 1, 256 steps. */
function rainbowTable(): Uint8Array {
  const out = new Uint8Array(SIZE * 3);
  const hinc = (0 - RAINBOW_HUE) / (SIZE - 1);
  for (let i = 0; i < SIZE; i++) {
    const rgb = hsvToRgb(RAINBOW_HUE + i * hinc, 1, 1);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.floor(rgb[k] * 255 + 0.5);
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const tables = new Map<ColormapName, Uint8Array>();

function table(name: ColormapName): Uint8Array {
  let t = tables.get(name);
  if (!t) {
    if (name === 'rainbow') t = rainbowTable();
    else if (name === 'viridis') t = fromHex(VIRIDIS_HEX);
    else if (name === 'balance') t = fromHex(BALANCE_HEX);
    else if (name === 'curl') t = fromHex(CURL_HEX);
    else throw new Error(`unknown colour map: ${String(name)}`);
    tables.set(name, t);
  }
  return t;
}

/** The map's 256 RGB entries (768 bytes), a new copy on each call. */
export function colormapRgb(name: ColormapName): Uint8Array {
  return table(name).slice();
}

function hexColour(t: Uint8Array, i: number): string {
  return '#' + [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A CSS linear-gradient (left to right) through `stops` evenly spaced entries of the map. */
export function colormapGradient(name: ColormapName, stops = 33): string {
  const t = table(name);
  const n = Math.max(2, Math.round(Number(stops) || 0));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry = Math.round((i * (SIZE - 1)) / (n - 1));
    const at = Number(((i * 100) / (n - 1)).toFixed(3));
    parts.push(`${hexColour(t, entry)} ${at}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}
