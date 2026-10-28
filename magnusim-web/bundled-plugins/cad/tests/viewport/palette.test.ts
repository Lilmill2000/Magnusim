// The 3D view's and the sketch's colours by theme (src/viewport/palette.ts): LIGHT is exactly
// the look before the dark set, DARK's thin marks read on the dark background, E2's candidates
// cover every coloured thin mark ((c)'s read on a body face too, and keep driven apart from
// driving), and both palettes agree with the CSS tokens they mirror (CAD's, and the host's
// appearance set).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { overlayColors, REGION_TINT } from '../../src/features/sketch/colors';
import { BODY_COLOR, EDGE_COLOR, HOVER_COLOR, PICK_COLOR, PLANE_BORDER, PLANE_FILL, TRIAD_COLORS, VIEWPORT_BG } from '../../src/viewport/colors';
import { DARK, DARK_INKS, DARK_LINE_OPTIONS, DARK_LINES_DEFAULT, darkPalette, hexNumber, hexString, LIGHT, paletteFor, paletteOf, samePalette, type MarkPalette } from '../../src/viewport/palette';
import { contrast, hostTokens, themeValue } from '../styles/css-tokens';

const num = (s: string | null | undefined) => hexNumber(String(s));

describe('LIGHT', () => {
  it('is exactly the colours before the dark set (colors.ts, and the sketch readers\' token fallbacks)', () => {
    expect(LIGHT.name).toBe('light');
    expect(LIGHT.background).toBe(0xf0f2f7);
    expect(LIGHT.edge).toBe(0x0a0b0e);
    expect(LIGHT.edgeRim).toBeNull();
    expect([...LIGHT.triad]).toEqual([0xdc2828, 0x24a840, 0x2860dc]);
    // features/refgeom/overlay.ts LINE_COLOR, features/measure/overlay.ts MEASURE_COLOR, the scale guide's and the arrows' 0x1570ef.
    expect(LIGHT.constructLine).toBe(0x2f5fb8);
    expect(LIGHT.measure).toBe(0x1a4fbf);
    expect(LIGHT.ink).toBe(0x1570ef);
    // sketch/overlay.ts readPalette's fallbacks (the host's light tokens).
    expect({ ...LIGHT.sketch }).toEqual({
      under: '#1570ef',
      fully: '#101828',
      over: '#b42318',
      construction: '#667085',
      pick: '#2ec47e',
      hover: '#b2ccff',
      preview: '#1570ef',
      dim: '#101828',
      driven: '#667085',
      grid: '#e8ebf0',
      gridMajor: '#cfd3db',
      doomed: '#b42318',
      linked: '#7a3fd1',
      lost: '#b54708',
    });
    expect(LIGHT.sketchRim).toBeNull();
    expect(LIGHT.lines).toBeNull();
    // The constants other code imports are the same values.
    expect(VIEWPORT_BG).toBe(LIGHT.background);
    expect(EDGE_COLOR).toBe(LIGHT.edge);
    expect([...TRIAD_COLORS]).toEqual([...LIGHT.triad]);
  });

  it("gives the model-mode sketch lines and regions the colours features/sketch/colors.ts read before", () => {
    expect(overlayColors(LIGHT)).toEqual({
      region: { color: 0x1570ef, opacity: 0.12 },
      hover: { color: HOVER_COLOR, opacity: 0.55 },
      picked: { color: PICK_COLOR, opacity: 0.4 },
      under: 0x1570ef,
      full: 0x101828,
      over: 0xb42318,
      construction: 0x667085,
      linked: 0x7a3fd1,
      lost: 0xb54708,
    });
    expect(overlayColors()).toEqual(overlayColors(LIGHT));
  });
});

describe('DARK', () => {
  it('turns only thin marks light: surfaces, picks, hover and tints stay as they are (D2, E5)', () => {
    expect(DARK.name).toBe('dark');
    expect(DARK.background).toBe(0x1b1f27);
    expect(DARK.sketch.pick).toBe(LIGHT.sketch.pick);
    expect(DARK.sketch.hover).toBe(LIGHT.sketch.hover);
    // The regions keep the constant tint, whatever the palette.
    expect(overlayColors(DARK).region).toEqual(REGION_TINT);
    expect(overlayColors(DARK).region).toEqual(overlayColors(LIGHT).region);
    expect(overlayColors(DARK).hover).toEqual(overlayColors(LIGHT).hover);
    expect(overlayColors(DARK).picked).toEqual(overlayColors(LIGHT).picked);
    // Nothing in the palette names a surface colour; they stay colors.ts' one value.
    expect(BODY_COLOR).toBe(0xbdc9db);
    expect(PLANE_FILL.color).toBe(0x4884eb);
    expect(PLANE_BORDER.opacity).toBe(0.55);
  });

  it('draws every mark at least 3:1 on its background; the grid reads at least as well as in light', () => {
    const low: string[] = [];
    const check = (p: MarkPalette, what: string, c: number) => {
      const r = contrast(c, p.background);
      if (r < 3) low.push(`${p.lines?.edges}/${p.lines?.sketch} ${what} ${hexString(c)}: ${r.toFixed(2)}`);
    };
    for (const o of ['a', 'b', 'c'] as const) {
      const p = darkPalette({ edges: o, sketch: o });
      check(p, 'edge', p.edge);
      p.triad.forEach((c, i) => check(p, `triad ${'xyz'[i]}`, c));
      check(p, 'constructLine', p.constructLine);
      check(p, 'measure', p.measure);
      check(p, 'ink', p.ink);
      for (const k of ['under', 'fully', 'over', 'construction', 'pick', 'hover', 'preview', 'dim', 'driven', 'doomed', 'linked', 'lost'] as const) check(p, `sketch.${k}`, num(p.sketch[k]));
    }
    expect(low).toEqual([]);
    for (const k of ['grid', 'gridMajor'] as const) expect(contrast(num(DARK.sketch[k]), DARK.background)).toBeGreaterThanOrEqual(contrast(num(LIGHT.sketch[k]), LIGHT.background));
    // In light the same marks: the blue arrow was the weakest triad colour (why E4 changes them).
    expect(contrast(LIGHT.triad[2], DARK.background)).toBeLessThan(3);
  });

  it('agrees with the CSS tokens it mirrors, in both themes', () => {
    const host = hostTokens();
    // LIGHT and E2's plain dark inks ((a) and (b)) are the host's tokens; their HTML twins take them too.
    for (const [p, theme] of [
      [LIGHT, 'light'],
      [darkPalette({ sketch: 'a' }), 'dark'],
      [darkPalette({ sketch: 'b' }), 'dark'],
    ] as const) {
      const css = (name: string) => num(themeValue(name, theme));
      const hostOf = (name: string) => num((theme === 'dark' ? host.dark : host.light).get(name));
      expect(p.background, `${theme} --cad-viewport-bg`).toBe(css('--cad-viewport-bg'));
      expect(p.measure, `${theme} --cad-p2-measure`).toBe(css('--cad-p2-measure'));
      expect(p.sketch.under).toBe(hexString(hostOf('--mg-primary-ink')));
      expect(p.sketch.fully).toBe(hexString(hostOf('--mg-text')));
      expect(p.sketch.dim).toBe(p.sketch.fully);
      expect(p.sketch.over, `${theme} --cad-sketch-over`).toBe(hexString(css('--cad-sketch-over')));
      expect(p.sketch.doomed).toBe(p.sketch.over);
      expect(p.sketch.lost, `${theme} --cad-sketch-lost`).toBe(hexString(css('--cad-sketch-lost')));
      expect(p.sketch.pick).toBe(hexString(css('--cad-pick')));
      expect(p.sketch.hover).toBe(hexString(css('--cad-hover-pick')));
      expect(p.sketch.preview).toBe(hexString(hostOf('--mg-primary-ink')));
      expect(p.ink).toBe(hostOf('--mg-primary-ink'));
      expect(p.sketch.construction).toBe(hexString(hostOf('--mg-text-muted')));
      expect(p.sketch.driven).toBe(p.sketch.construction);
      expect(p.sketch.grid).toBe(hexString(hostOf('--mg-divider')));
      expect(p.sketch.gridMajor).toBe(hexString(hostOf('--mg-card-border')));
    }
    expect(LIGHT.sketch.linked).toBe('#7a3fd1');
    expect(darkPalette({ sketch: 'a' }).sketch.linked).toBe('#9b7bf0');
    expect(darkPalette({ sketch: 'a' }).constructLine).toBe(num(host.dark.get('--mg-link')));
    // The keys to the line colours (the Sketch panel's state dot, a reference's dot): LIGHT's in the
    // light block, the default's ((c)) in the dark one (app/appearance.ts sets another candidate's).
    for (const [p, theme] of [
      [LIGHT, 'light'],
      [DARK, 'dark'],
    ] as const) {
      const key = (k: string) => hexString(num(themeValue(`--cad-sketch-key-${k}`, theme)));
      expect({ under: key('under'), full: key('full'), over: key('over'), linked: key('linked'), lost: key('lost') }, theme).toEqual({ under: p.sketch.under, full: p.sketch.fully, over: p.sketch.over, linked: p.sketch.linked, lost: p.sketch.lost });
    }
    expect(DARK.background).toBe(num(host.dark.get('--mg-viewport-bg')));
    expect(DARK.background).toBe(num(themeValue('--cad-viewport-bg', 'dark')));
    // E4: the triad takes the host's dark axis colours, as the axes key's letters do.
    expect([...DARK.triad]).toEqual(['--cad-axis-x', '--cad-axis-y', '--cad-axis-z'].map((n) => num(themeValue(n, 'dark'))));
  });
});

describe('the E1 / E2 switch', () => {
  it('is (c), the mid grey, for both until Daniel picks', () => {
    expect(DARK_LINES_DEFAULT).toEqual({ edges: 'c', sketch: 'c' });
    expect(DARK.lines).toEqual({ edges: 'c', sketch: 'c' });
    expect(DARK.edge).toBe(0x8a93a3);
    expect(DARK.sketch.fully).toBe('#8a93a3');
    expect(DARK.edgeRim).toBeNull();
    expect(DARK.sketchRim).toBeNull();
  });

  it('gives each candidate its colour, and (b) a rim in the background colour', () => {
    expect(DARK_LINE_OPTIONS).toEqual({ a: { color: 0xe6e9ef, rim: false }, b: { color: 0xe6e9ef, rim: true }, c: { color: 0x8a93a3, rim: false } });
    const a = darkPalette({ edges: 'a', sketch: 'a' });
    expect([a.edge, a.edgeRim, a.sketch.fully, a.sketch.dim, a.sketchRim]).toEqual([0xe6e9ef, null, '#e6e9ef', '#e6e9ef', null]);
    const b = darkPalette({ edges: 'b', sketch: 'b' });
    expect([b.edge, b.edgeRim, b.sketch.fully, b.sketchRim]).toEqual([0xe6e9ef, 0x1b1f27, '#e6e9ef', '#1b1f27']);
    // Edges and sketch lines are chosen apart.
    const mixed = darkPalette({ edges: 'b', sketch: 'c' });
    expect([mixed.edge, mixed.edgeRim, mixed.sketch.fully, mixed.sketchRim]).toEqual([0xe6e9ef, 0x1b1f27, '#8a93a3', null]);
    // (a) and (b) differ by the rims only; the background, the triad, picks, hover and grid are the same in every candidate.
    const strip = (p: MarkPalette) => ({ ...p, edge: 0, edgeRim: 0, lines: null, sketchRim: null });
    expect(strip(a)).toEqual(strip(b));
    const fixed = (p: MarkPalette) => ({ background: p.background, triad: p.triad, pick: p.sketch.pick, hover: p.sketch.hover, grid: p.sketch.grid, gridMajor: p.sketch.gridMajor });
    expect(fixed(a)).toEqual(fixed(DARK));
  });

  it('E2 is every coloured thin mark: (c) gives each its own mid tone, each reading on the background and on a body face', () => {
    const a = darkPalette({ sketch: 'a' });
    const c = darkPalette({ sketch: 'c' });
    const marks = (p: MarkPalette): Record<string, number> => ({
      ...Object.fromEntries((['under', 'fully', 'over', 'construction', 'preview', 'dim', 'driven', 'doomed', 'linked', 'lost'] as const).map((k) => [k, num(p.sketch[k])])),
      ink: p.ink,
      constructLine: p.constructLine,
      measure: p.measure,
    });
    // Every one of them is the candidate's: none is the same in (a) and (c).
    const ma = marks(a);
    const mc = marks(c);
    expect(Object.keys(mc).filter((k) => mc[k] === ma[k])).toEqual([]);
    expect(DARK_INKS.a).toBe(DARK_INKS.b);
    // (c): at least 3:1 on the dark background and 2.8:1 on a body face (light's own inks read 2.7 to
    // 3.9:1 on one); the fully defined mid grey is Daniel's candidate value (5.3:1 and 1.85:1).
    const low: string[] = [];
    for (const [k, v] of Object.entries(mc)) {
      const bg = contrast(v, c.background);
      const face = contrast(v, BODY_COLOR);
      const minFace = k === 'fully' || k === 'dim' ? 1.8 : 2.8;
      if (bg < 3 || face < minFace) low.push(`${k} ${hexString(v)}: ${bg.toFixed(2)} on the background, ${face.toFixed(2)} on a face`);
    }
    expect(low).toEqual([]);
    // (a) and (b)'s light inks read badly on a face (why (b) rims them and (c) exists).
    expect(contrast(ma.under, BODY_COLOR)).toBeLessThan(1.6);
    expect(contrast(ma.lost, BODY_COLOR)).toBeLessThan(1.2);
  });

  it('keeps a driven dimension and construction apart from the fully defined lines in every candidate (light: 3.57:1)', () => {
    expect(contrast(num(LIGHT.sketch.dim), num(LIGHT.sketch.driven))).toBeGreaterThan(3.5);
    for (const o of ['a', 'b', 'c'] as const) {
      const p = darkPalette({ sketch: o });
      expect(contrast(num(p.sketch.dim), num(p.sketch.driven)), `(${o}) driving vs driven`).toBeGreaterThanOrEqual(1.6);
      expect(contrast(num(p.sketch.fully), num(p.sketch.construction)), `(${o}) fully vs construction`).toBeGreaterThanOrEqual(1.6);
    }
    // (c): the driven and construction grey is darker than the fully defined mid grey (it was a lighter one, 1.23:1 apart).
    expect(DARK.sketch.driven).toBe('#646d7e');
  });
});

describe('paletteFor / paletteOf / samePalette', () => {
  it('is DARK for "dark" in any case, LIGHT for anything else (an older host has no theme)', () => {
    expect(paletteFor('dark')).toBe(DARK);
    expect(paletteFor('Dark')).toBe(DARK);
    expect(paletteFor(' DARK ')).toBe(DARK);
    for (const t of ['light', 'x', '', 'darker', null, undefined]) expect(paletteFor(t as string | null | undefined)).toBe(LIGHT);
    expect(paletteFor('dark', { edges: 'a' }).edge).toBe(0xe6e9ef);
    expect(paletteFor('light', { edges: 'a' })).toBe(LIGHT);
  });

  it('reads the view\'s palette, LIGHT for a handle without one', () => {
    expect(paletteOf(null)).toBe(LIGHT);
    expect(paletteOf({})).toBe(LIGHT);
    expect(paletteOf({ palette: () => DARK })).toBe(DARK);
  });

  it('tells palettes apart by theme and candidates', () => {
    expect(samePalette(LIGHT, LIGHT)).toBe(true);
    expect(samePalette(DARK, darkPalette())).toBe(true);
    expect(samePalette(DARK, LIGHT)).toBe(false);
    expect(samePalette(DARK, darkPalette({ edges: 'a' }))).toBe(false);
  });

  it('converts colours both ways', () => {
    expect(hexString(0x0a0b0e)).toBe('#0a0b0e');
    expect(hexNumber('#1570EF')).toBe(0x1570ef);
    expect(() => hexNumber('red')).toThrow();
  });
});
