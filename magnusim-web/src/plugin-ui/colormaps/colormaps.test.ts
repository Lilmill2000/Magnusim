import vtkLookupTable from '@kitware/vtk.js/Common/Core/LookupTable';
import { ScalarMappingTarget } from '@kitware/vtk.js/Common/Core/ScalarsToColors/Constants';
import { describe, expect, it } from 'vitest';
import { createRainbowLut } from '../../viewer/lut';
import { COLORMAPS, colormapGradient, colormapRgb, RAINBOW_HUE, type ColormapName } from '.';

const byte = (v: number) => Math.floor(v * 255 + 0.5);
const entry = (t: Uint8Array, i: number) => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
const hex = (rgb: number[]) => '#' + rgb.map((b) => b.toString(16).padStart(2, '0')).join('');
const HEAD = 'linear-gradient(to right, ';
const stopsOf = (g: string) => g.slice(HEAD.length, -1).split(', ');

// The first and last rows of each upstream table (data.ts names the files and their sha256).
const UPSTREAM: Record<Exclude<ColormapName, 'rainbow'>, [number[], number[]]> = {
  // BIDS/colormap option_d.py cm_data, rows 1 and 256.
  viridis: [
    [0.26700401, 0.00487433, 0.32941519],
    [0.99324789, 0.90615657, 0.1439362],
  ],
  // cmocean v4.0.3 balance-rgb.txt, rows 1 and 256.
  balance: [
    [9.317630180115785143e-2, 1.111733294776027225e-1, 2.615123885530547532e-1],
    [2.36056364664614049e-1, 3.529747994604028744e-2, 6.943744239412558139e-2],
  ],
  // cmocean v4.0.3 curl-rgb.txt, rows 1 and 512 (the resample to 256 keeps both ends).
  curl: [
    [8.225559928700268419e-2, 1.149244079727295142e-1, 2.647901677800857390e-1],
    [2.034002463374002811e-1, 5.12571528517886052e-2, 2.085372063771265272e-1],
  ],
};

/** The bytes a vtk.js lookup table maps entry i to, as the renders build theirs (runtime.js). */
function vtkRainbow(hue: number): Uint8Array {
  const lut = vtkLookupTable.newInstance() as unknown as {
    setHueRange: (a: number, b: number) => void;
    setSaturationRange: (a: number, b: number) => void;
    setValueRange: (a: number, b: number) => void;
    setNumberOfColors: (n: number) => void;
    setRange: (a: number, b: number) => void;
    build: () => void;
    mapScalarsThroughTable: (input: unknown, output: unknown, format: number, offset: number) => void;
  };
  lut.setHueRange(hue, 0.0);
  lut.setSaturationRange(1.0, 1.0);
  lut.setValueRange(1.0, 1.0);
  lut.setNumberOfColors(256);
  lut.setRange(0, 255);
  lut.build();
  // Entry i for the value i: the table's own bytes, truncated into a Uint8Array as a render's are.
  const input = Float32Array.from({ length: 256 }, (_, i) => i);
  const rgba = new Uint8Array(256 * 4);
  lut.mapScalarsThroughTable(
    { getNumberOfTuples: () => 256, getNumberOfComponents: () => 1, getData: () => input },
    { getData: () => rgba },
    ScalarMappingTarget.RGBA,
    0,
  );
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = rgba[i * 4 + k];
  return out;
}

describe('colour maps', () => {
  it('lists rainbow, viridis, balance and curl, frozen', () => {
    expect([...COLORMAPS]).toEqual(['rainbow', 'viridis', 'balance', 'curl']);
    expect(Object.isFrozen(COLORMAPS)).toBe(true);
    expect(() => (COLORMAPS as ColormapName[]).push('rainbow')).toThrow();
  });

  it('holds 256 RGB entries (768 bytes) per map', () => {
    for (const name of COLORMAPS) {
      const t = colormapRgb(name);
      expect(t, name).toBeInstanceOf(Uint8Array);
      expect(t.length, name).toBe(768);
    }
  });

  it('starts and ends on the upstream rows, at 8 bits (floor(v * 255 + 0.5))', () => {
    for (const [name, [first, last]] of Object.entries(UPSTREAM) as Array<[ColormapName, [number[], number[]]]>) {
      const t = colormapRgb(name);
      expect(entry(t, 0), name).toEqual(first.map(byte));
      expect(entry(t, 255), name).toEqual(last.map(byte));
    }
    expect(hex(entry(colormapRgb('viridis'), 0))).toBe('#440154');
    expect(hex(entry(colormapRgb('viridis'), 255))).toBe('#fde725');
  });

  it('builds the rainbow exactly as a vtk.js lookup table with hue 0.667 to 0', () => {
    expect(RAINBOW_HUE).toBe(0.667);
    const vtk = vtkRainbow(0.667);
    expect(Array.from(colormapRgb('rainbow'))).toEqual(Array.from(vtk));
    expect(hex(entry(vtk, 0))).toBe('#0100ff');
    expect(hex(entry(vtk, 255))).toBe('#ff0000');
    // The old 0.666 table differs: the hue matters.
    expect(Array.from(vtkRainbow(0.666))).not.toEqual(Array.from(vtk));
  });

  it('gives the plugin API rainbow (createRainbowLut) the same hue', () => {
    const lut = createRainbowLut() as unknown as { getHueRange: () => number[] };
    expect(lut.getHueRange()).toEqual([RAINBOW_HUE, 0]);
  });

  it('returns a fresh copy each time, so a caller cannot change the table', () => {
    const a = colormapRgb('viridis');
    a.fill(0);
    const b = colormapRgb('viridis');
    expect(b).not.toBe(a);
    expect(hex(entry(b, 0))).toBe('#440154');
    const r = colormapRgb('rainbow');
    r[0] = 99;
    expect(colormapRgb('rainbow')[0]).toBe(1);
  });

  it('throws on an unknown map', () => {
    expect(() => colormapRgb('jet' as ColormapName)).toThrow(/unknown colour map: jet/);
  });

  it('builds a CSS gradient from the table bytes', () => {
    for (const name of COLORMAPS) {
      const t = colormapRgb(name);
      const g = colormapGradient(name);
      expect(g.startsWith(HEAD) && g.endsWith(')'), name).toBe(true);
      expect(g, name).not.toMatch(/rgb\(/);
      const stops = stopsOf(g);
      expect(stops, name).toHaveLength(33);
      for (const s of stops) expect(s, name).toMatch(/^#[0-9a-f]{6} [\d.]+%$/);
      expect(stops[0], name).toBe(`${hex(entry(t, 0))} 0%`);
      expect(stops[32], name).toBe(`${hex(entry(t, 255))} 100%`);
      // Stop i is entry round(i * 255 / 32), at i / 32 of the width.
      expect(stops[1], name).toBe(`${hex(entry(t, 8))} 3.125%`);
      expect(stops[16], name).toBe(`${hex(entry(t, 128))} 50%`);
    }
  });

  it('takes the number of stops', () => {
    const t = colormapRgb('balance');
    expect(stopsOf(colormapGradient('balance', 5))).toEqual([0, 64, 128, 191, 255].map((i, k) => `${hex(entry(t, i))} ${k * 25}%`));
    // At least the two ends.
    expect(stopsOf(colormapGradient('curl', 1))).toHaveLength(2);
  });
});
