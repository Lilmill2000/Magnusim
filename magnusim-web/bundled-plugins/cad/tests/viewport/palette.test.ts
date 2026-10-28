// The 3D view's and the sketch's colours by theme (src/viewport/palette.ts): LIGHT is the core's
// light values (the look before the dark set, the triad the core's unified light axes); DARK's
// thin marks read on the dark background, E1 is the host's dark text colour (Daniel: option a),
// E2's face inks are exactly LIGHT's, role by role (Daniel: "the colour follows what's under
// it"), every dark sketch ink has one face ink, and both palettes agree with the CSS tokens they
// mirror (CAD's, and the host's appearance set).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { overlayColors, REGION_TINT } from '../../src/features/sketch/colors';
import { BODY_COLOR, EDGE_COLOR, HOVER_COLOR, PICK_COLOR, PLANE_BORDER, PLANE_FILL, TRIAD_COLORS, VIEWPORT_BG } from '../../src/viewport/colors';
import { DARK, faceSketchInk, hexNumber, hexString, LIGHT, paletteFor, paletteOf, samePalette, sketchRolesOf, type MarkPalette, type SketchInk } from '../../src/viewport/palette';
import { TIP_LEN, TIP_R } from '../../src/viewport/triad';
import { contrast, hostTokens, themeValue } from '../styles/css-tokens';

const num = (s: string | null | undefined) => hexNumber(String(s));
const ROLES = ['under', 'fully', 'over', 'construction', 'pick', 'hover', 'preview', 'dim', 'driven', 'grid', 'gridMajor', 'doomed', 'linked', 'lost'] as const satisfies readonly (keyof SketchInk)[];

describe('LIGHT', () => {
  it('is the core\'s light colours (colors.ts, and the sketch readers\' token fallbacks)', () => {
    expect(LIGHT.name).toBe('light');
    expect(LIGHT.background).toBe(0xf0f2f7);
    expect(LIGHT.edge).toBe(0x0a0b0e);
    // The host's light --mg-axis-x / -y / -z, the core triad's since its light unify.
    expect([...LIGHT.triad]).toEqual([0xd42828, 0x1f9a3a, 0x2a5bd7]);
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
    // Nothing is drawn twice in light: no face inks.
    expect(LIGHT.face).toBeNull();
    for (const ink of Object.values(LIGHT.sketch)) expect(faceSketchInk(LIGHT, ink)).toBe(ink);
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

  it("E1 (a): the edges are the host's dark text colour, plain (no rim, nothing else to choose)", () => {
    expect(DARK.edge).toBe(0xe6e9ef);
    expect(DARK.edge).toBe(num(hostTokens().dark.get('--mg-text')));
    expect(Object.keys(DARK).sort()).toEqual(['background', 'constructLine', 'edge', 'face', 'ink', 'measure', 'name', 'sketch', 'triad', 'triadLight']);
    expect(Object.keys(LIGHT).sort()).toEqual(Object.keys(DARK).sort());
  });

  it('draws every mark at least 3:1 on its background; the grid reads at least as well as in light', () => {
    const low: string[] = [];
    const check = (what: string, c: number) => {
      const r = contrast(c, DARK.background);
      if (r < 3) low.push(`${what} ${hexString(c)}: ${r.toFixed(2)}`);
    };
    check('edge', DARK.edge);
    DARK.triad.forEach((c, i) => check(`triad ${'xyz'[i]}`, c));
    check('constructLine', DARK.constructLine);
    check('measure', DARK.measure);
    check('ink', DARK.ink);
    for (const k of ['under', 'fully', 'over', 'construction', 'pick', 'hover', 'preview', 'dim', 'driven', 'doomed', 'linked', 'lost'] as const) check(`sketch.${k}`, num(DARK.sketch[k]));
    expect(low).toEqual([]);
    for (const k of ['grid', 'gridMajor'] as const) expect(contrast(num(DARK.sketch[k]), DARK.background)).toBeGreaterThanOrEqual(contrast(num(LIGHT.sketch[k]), LIGHT.background));
    // In light the same marks: the blue arrow was the weakest triad colour (why E4 changes them).
    expect(contrast(LIGHT.triad[2], DARK.background)).toBeLessThan(3);
  });

  it("E4: lights the dark triad so an arrow pointing at the eye still reads 3:1; light's is the core's", () => {
    // The core's vtkAxesActor: the headlight alone.
    expect(LIGHT.triadLight).toEqual({ ambient: 0, diffuse: 1 });
    // Seen end on, pointing at the eye, an arrow shows only its cone's sides (the shaft behind it),
    // whose normals lean towards the eye by the cone's half-angle: the headlight term is its sine.
    const side = Math.sin(Math.atan(TIP_R / TIP_LEN));
    expect(side).toBeCloseTo(0.447, 3);
    const lit = (c: number, k: number) => [16, 8, 0].reduce((n, s) => n | (Math.min(255, Math.round(((c >> s) & 255) * k)) << s), 0);
    const worst = (p: MarkPalette) => p.triad.map((c) => contrast(lit(c, p.triadLight.ambient + p.triadLight.diffuse * side), DARK.background));
    // Lit as in light, the X and Z arrows end on read under 2:1 on the dark background (review: the dim Y arrow).
    expect(Math.min(...worst({ ...DARK, triadLight: LIGHT.triadLight }))).toBeLessThan(2);
    for (const [i, r] of worst(DARK).entries()) expect(r, `${'xyz'[i]} end on`).toBeGreaterThanOrEqual(3);
    // A side facing the light keeps the arrow's full colour.
    expect(DARK.triadLight.ambient + DARK.triadLight.diffuse).toBe(1);
  });

  it("E2: over a light surface every mark takes LIGHT's colour for its role, exactly", () => {
    const f = DARK.face!;
    expect(f).not.toBeNull();
    expect({ edge: f.edge, constructLine: f.constructLine, measure: f.measure, ink: f.ink }).toEqual({ edge: LIGHT.edge, constructLine: LIGHT.constructLine, measure: LIGHT.measure, ink: LIGHT.ink });
    // E1 too: over a face the edges are the light view's near-black, over the background #e6e9ef.
    expect([f.edge, DARK.edge]).toEqual([0x0a0b0e, 0xe6e9ef]);
    expect({ ...f.sketch }).toEqual({ ...LIGHT.sketch });
    // Role by role, not by value: the dark reference axes, the arrows' ink and the under-defined
    // lines are one blue, but over a face the axes take LIGHT's darker construct blue.
    expect(DARK.constructLine).toBe(DARK.ink);
    expect(hexString(DARK.ink)).toBe(DARK.sketch.under);
    expect(f.constructLine).not.toBe(f.ink);
    expect(f.constructLine).toBe(0x2f5fb8);
    expect(f.ink).toBe(0x1570ef);
  });

  it('E2: each dark sketch ink is one face ink (the lines and points map colours, so no two roles of one colour differ over a face)', () => {
    const clash: string[] = [];
    for (const ink of new Set(Object.values(DARK.sketch))) {
      const faces = new Set(sketchRolesOf(DARK, ink).map((r) => LIGHT.sketch[r]));
      if (faces.size !== 1) clash.push(`${ink}: ${sketchRolesOf(DARK, ink).join(', ')} -> ${[...faces].join(', ')}`);
    }
    expect(clash).toEqual([]);
    // And the map is the roles': each role's dark ink to its LIGHT ink, in any case of the hex.
    for (const r of ROLES) {
      expect(faceSketchInk(DARK, DARK.sketch[r]), r).toBe(LIGHT.sketch[r]);
      expect(faceSketchInk(DARK, DARK.sketch[r].toUpperCase()), r).toBe(LIGHT.sketch[r]);
    }
    // A pick and a hover keep their colours (the same in both); a colour the palette lacks is itself.
    expect(faceSketchInk(DARK, DARK.sketch.pick)).toBe(DARK.sketch.pick);
    expect(faceSketchInk(DARK, DARK.sketch.hover)).toBe(DARK.sketch.hover);
    expect(faceSketchInk(DARK, '#123456')).toBe('#123456');
  });

  it('keeps a driven dimension and construction apart from the fully defined lines (light: 3.57:1)', () => {
    expect(contrast(num(LIGHT.sketch.dim), num(LIGHT.sketch.driven))).toBeGreaterThan(3.5);
    expect(contrast(num(DARK.sketch.dim), num(DARK.sketch.driven)), 'driving vs driven').toBeGreaterThanOrEqual(1.6);
    expect(contrast(num(DARK.sketch.fully), num(DARK.sketch.construction)), 'fully vs construction').toBeGreaterThanOrEqual(1.6);
  });

  it('agrees with the CSS tokens it mirrors, in both themes', () => {
    const host = hostTokens();
    // LIGHT's and DARK's own inks are the host's tokens; their HTML twins take them too.
    for (const [p, theme] of [
      [LIGHT, 'light'],
      [DARK, 'dark'],
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
    expect(DARK.sketch.linked).toBe('#9b7bf0');
    expect(DARK.constructLine).toBe(num(host.dark.get('--mg-link')));
    // The keys to the line colours (the Sketch panel's state dot, a reference's dot): each theme's
    // inks over its background; in dark also the face half (an inset shadow) in LIGHT's ink, on a
    // crescent of the body colour; none in light.
    const KEYS = { under: 'under', full: 'fully', over: 'over', linked: 'linked', lost: 'lost' } as const;
    for (const [p, theme] of [
      [LIGHT, 'light'],
      [DARK, 'dark'],
    ] as const) {
      for (const [k, role] of Object.entries(KEYS)) {
        expect(hexString(num(themeValue(`--cad-sketch-key-${k}`, theme))), `${theme} key ${k}`).toBe(p.sketch[role]);
        const onFace = themeValue(`--cad-sketch-key-${k}-on-face`, theme);
        if (theme === 'light') expect(onFace, `light key ${k} on a face`).toBe('none');
        else expect(onFace, `dark key ${k} on a face`).toBe(`inset 4px 0 0 0 ${DARK.face!.sketch[role]}, -1.5px 0 0 0.5px ${hexString(BODY_COLOR)}`);
      }
    }
    expect(DARK.background).toBe(num(host.dark.get('--mg-viewport-bg')));
    expect(DARK.background).toBe(num(themeValue('--cad-viewport-bg', 'dark')));
    // E4: the triad takes the host's dark axis colours, as the axes key's letters do; in light
    // its light ones, as the core's triad and the key's letters do.
    expect([...DARK.triad]).toEqual(['--cad-axis-x', '--cad-axis-y', '--cad-axis-z'].map((n) => num(themeValue(n, 'dark'))));
    expect([...LIGHT.triad]).toEqual(['--cad-axis-x', '--cad-axis-y', '--cad-axis-z'].map((n) => num(themeValue(n, 'light'))));
    expect([...LIGHT.triad]).toEqual(['--mg-axis-x', '--mg-axis-y', '--mg-axis-z'].map((n) => num(host.light.get(n))));
  });
});

describe('paletteFor / paletteOf / samePalette', () => {
  it('is DARK for "dark" in any case, LIGHT for anything else (an older host has no theme)', () => {
    expect(paletteFor('dark')).toBe(DARK);
    expect(paletteFor('Dark')).toBe(DARK);
    expect(paletteFor(' DARK ')).toBe(DARK);
    for (const t of ['light', 'x', '', 'darker', null, undefined]) expect(paletteFor(t as string | null | undefined)).toBe(LIGHT);
  });

  it('reads the view\'s palette, LIGHT for a handle without one', () => {
    expect(paletteOf(null)).toBe(LIGHT);
    expect(paletteOf({})).toBe(LIGHT);
    expect(paletteOf({ palette: () => DARK })).toBe(DARK);
  });

  it('tells palettes apart by theme', () => {
    expect(samePalette(LIGHT, LIGHT)).toBe(true);
    expect(samePalette(DARK, { ...DARK } as MarkPalette)).toBe(true);
    expect(samePalette(DARK, LIGHT)).toBe(false);
  });

  it('converts colours both ways', () => {
    expect(hexString(0x0a0b0e)).toBe('#0a0b0e');
    expect(hexNumber('#1570EF')).toBe(0x1570ef);
    expect(() => hexNumber('red')).toThrow();
  });
});
