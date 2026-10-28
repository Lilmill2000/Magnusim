// The tunnel's tokens: the view's colours the GPU reads (src/app/colours.ts) are plain hex, which
// tokenRgb can read, with no dark value; the tokens built on the host's are declared again on any
// element with a theme of its own (the hidden light element the GPU, pictures and recordings read),
// so they take the host's light values there; in light each colour is the one the tunnel drew
// before, and the swatches' dark ring has no declaration; and in dark what is drawn on the view's
// margins, on a map's ends, on the plain and tank looks, on a body and on the marks' halo reads
// clearly, as do the swatches on the panel's rows.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colormapRgb } from '../../../src/plugin-ui/colormaps';
import { INFERNO } from '../src/render/inferno';
import { hostDark, hostLight, readCss, tokenReader, tunnel, tunnelBase, tunnelDark } from './themeTokens';

const coloursTs = readFileSync(join(__dirname, '..', 'src', 'app', 'colours.ts'), 'utf8');
/** A function's source in a module's text: from its name to the brace that closes its body. */
function functionSource(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  let i = src.indexOf('{', at);
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(at, i + 1);
}
// What the GPU draws with: the engine's palette and the rest of its colours.
const gpuTs = functionSource(coloursTs, 'viewPalette') + functionSource(coloursTs, 'applyViewColours');

// The tunnel tokens colours.ts reads; the rheoscopic presets' are built from the preset's name,
// the rakes' from their number.
const GPU_TOKENS = [
  '--t2d-bg',
  '--t2d-body',
  '--t2d-edge',
  '--t2d-zone',
  '--t2d-plain',
  '--t2d-arrow',
  '--t2d-body-dark',
  '--t2d-edge-light',
  '--t2d-particle-dark',
  '--t2d-particle-light',
  '--t2d-streamline',
];
const RHEO_PRESETS = ['kalliroscope', 'pearl', 'copper'];
const RHEO_TOKENS = RHEO_PRESETS.flatMap((p) => ['base', 'light1', 'light2'].map((l) => `--t2d-rheo-${p}-${l}`));
const RAKE_TOKENS = [1, 2, 3, 4, 5, 6].map((i) => `--t2d-rake-${i}`);

/**
 * The marks' and the cards' colours as the tunnel drew them before it followed the theme (the
 * stage pinned light; the cards read on the light page): each token must still give its value in
 * light. The probe's ring and the handles were --mg-bg, the selected probe's name the selection's
 * blue, the rakes the host's light series.
 */
const DRAWN_BEFORE: Record<string, string> = {
  '--t2d-select': '#1570ef',
  '--t2d-select-ink': '#1570ef',
  '--t2d-ghost': '#475467',
  '--t2d-halo': '#ffffff',
  '--t2d-probe': '#101828',
  '--t2d-sketch-under': '#1570ef',
  '--t2d-sketch-full': '#101828',
  '--t2d-sketch-over': '#b42318',
  '--t2d-sketch-construction': '#667085',
  '--t2d-sketch-pick': '#12855a',
  '--t2d-sketch-halo': '#ffffff',
  '--t2d-sketch-preview': '#1570ef',
  '--t2d-rake-1': '#1570ef',
  '--t2d-rake-2': '#6941c6',
  '--t2d-rake-3': '#099250',
  '--t2d-rake-4': '#b54708',
  '--t2d-rake-5': '#0086c9',
  '--t2d-rake-6': '#dd2590',
  '--mg-bg': '#ffffff',
  '--mg-text': '#101828',
  // The stage's background was --t2d-bg; the dark-only edges and halos are none in light.
  '--t2d-margin': '#f0f2f7',
  '--t2d-wall': 'transparent',
  '--t2d-mark-halo': 'transparent',
};

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexOf = (rgb: ArrayLike<number>, i: number) => `#${[0, 1, 2].map((k) => rgb[3 * i + k].toString(16).padStart(2, '0')).join('')}`;

describe('the tunnel tokens', () => {
  it('are declared on the page and again on any element with a theme of its own; dark values come after', () => {
    expect(tunnelBase.selectors).toEqual([':root', '[data-theme]']);
    // A token built on the host's resolves where it is declared: on the light element it takes
    // the light theme only because it is declared there too. The one dark block has the same
    // specificity, so it comes after the base block.
    const blocks = tunnel.filter((r) => Object.keys(r.props).length);
    expect(blocks.map((r) => r.selectors.join(', '))).toEqual([':root, [data-theme]', '[data-theme="dark"]']);
    for (const r of blocks) {
      for (const [name, value] of Object.entries(r.props)) {
        if (value.includes('var(')) expect(r === tunnelBase || r === tunnelDark, name).toBe(true);
      }
    }
  });

  it('give the GPU no dark value: the dark block holds only what is drawn over the view and the swatches', () => {
    expect(Object.keys(tunnelDark.props).sort()).toEqual(['--t2d-ghost', '--t2d-mark-halo', '--t2d-sketch-pick', '--t2d-swatch-ring', '--t2d-wall']);
    for (const name of [...GPU_TOKENS, ...RHEO_TOKENS, ...RAKE_TOKENS]) expect(tunnelDark.props[name], name).toBeUndefined();
    // Every dark value is the host's own (the core's dark 3D view: its edge grey, pick green and halo).
    for (const [name, value] of Object.entries(tunnelDark.props)) {
      const ref = /^var\((--mg-[\w-]+)\)$/.exec(value);
      expect(ref, name).not.toBeNull();
      expect(hostDark.props[ref![1]] ?? hostLight.props[ref![1]], `${name}: ${value}`).toBeDefined();
    }
  });

  it('that colours.ts reads for the GPU are this list, each a plain hex colour', () => {
    const literal = [...gpuTs.matchAll(/--t2d-[a-z0-9-]+(?=['`])/g)].map((m) => m[0]);
    expect([...new Set(literal)].sort()).toEqual([...GPU_TOKENS].sort());
    expect([...gpuTs.matchAll(/look\('([a-z]+)'/g)].map((m) => m[1])).toEqual(RHEO_PRESETS);
    expect(gpuTs).toContain('`--t2d-rheo-${name}-base`');
    expect(gpuTs).toContain('`--t2d-rheo-${name}-light1`');
    expect(gpuTs).toContain('`--t2d-rheo-${name}-light2`');
    expect(gpuTs).toContain('`--t2d-rake-${i}`');
    expect(gpuTs).not.toContain('--mg-');
    for (const name of [...GPU_TOKENS, ...RHEO_TOKENS, ...RAKE_TOKENS]) expect(tunnelBase.props[name], name).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("the rakes and their dye are the host's light series colours, in every theme", () => {
    for (let i = 1; i <= 6; i++) expect(tunnelBase.props[`--t2d-rake-${i}`], `--t2d-rake-${i}`).toBe(hostLight.props[`--mg-series-${i}`]);
    expect(coloursTs).not.toContain('--mg-series');
  });

  it("the view's background is the host's light view background", () => {
    expect(tunnelBase.props['--t2d-bg']).toBe(hostLight.props['--mg-viewport-bg']);
  });

  it("built on the host's take the host's light values on a light element", () => {
    expect(hostLight.selectors).toContain(':root');
    for (const [name, value] of Object.entries(tunnelBase.props)) {
      const ref = /^var\((--mg-[\w-]+)\)$/.exec(value);
      if (value.includes('var(')) expect(ref, name).not.toBeNull();
      if (ref) expect(hostLight.props[ref[1]], `${name}: ${value}`).toBeDefined();
    }
  });

  it('give the marks and the cards, in light, the colours they were drawn in before', () => {
    const light = tokenReader('light');
    for (const [name, value] of Object.entries(DRAWN_BEFORE)) expect(light(name), name).toBe(value);
  });

  it("leave the swatches' ring to a dark rule: the light look has no declaration of it (scripts/theme-light-identity.mjs --strict)", () => {
    const app = readCss('..', 'src', 'styles', 'app.css');
    const uses = [...app.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[2].includes('--t2d-swatch-ring'));
    expect(uses.map((m) => m[1].trim())).toEqual(['[data-theme="dark"] .t2d-swatch']);
    expect(tunnelBase.props['--t2d-swatch-ring']).toBeUndefined();
  });

  it("in dark: the margins are the host's dark view background, and what is drawn over the view reads clearly", () => {
    const dark = tokenReader('dark');
    const light = tokenReader('light');
    const margin = dark('--t2d-margin');
    expect(margin).toBe(hostDark.props['--mg-viewport-bg']);
    expect(dark('--t2d-bg'), 'the GPU stays light').toBe(light('--t2d-bg'));
    // What lines with no halo of their own lie on: the margins, the plain and tank looks, each
    // colour map's ends, and white (a light field).
    const under: Record<string, string> = { margin, plain: dark('--t2d-plain'), white: '#ffffff' };
    for (const p of ['kalliroscope', 'pearl', 'copper']) under[`${p} tank`] = dark(`--t2d-rheo-${p}-base`);
    for (const map of ['viridis', 'balance'] as const) for (const i of [0, 255]) under[`${map} ${i}`] = hexOf(colormapRgb(map), i);
    for (const i of [0, 255]) under[`inferno ${i}`] = hexOf(INFERNO, i);
    const lines = ['--t2d-select', '--t2d-ghost', '--t2d-wall'];
    for (const name of lines) for (const [on, bg] of Object.entries(under)) expect(contrast(dark(name), bg), `${name} ${dark(name)} on ${on} ${bg}`).toBeGreaterThanOrEqual(3);
    // On the marks' halo (the probes' ring and names, the sketch and its dimensions): text 4.5:1, lines 3:1.
    const halo = dark('--t2d-halo');
    expect([dark('--t2d-mark-halo'), dark('--t2d-sketch-halo')]).toEqual([halo, halo]);
    // The dashed outlines lie on a body too (the pose a body is going to, over the body catching
    // up), where the ghost's grey is under 3:1 (one grey at 3:1 on the margins, the map ends and a
    // body would need a luminance of 0.157 to 0.159): on the mark halo, which reads there.
    const bodies = { body: dark('--t2d-body'), 'body (particles)': dark('--t2d-body-dark') };
    expect(contrast(dark('--t2d-ghost'), dark('--t2d-body'))).toBeLessThan(3);
    expect(contrast(dark('--t2d-ghost'), halo)).toBeGreaterThanOrEqual(3);
    for (const [on, bg] of Object.entries({ ...under, ...bodies })) {
      expect(Math.max(contrast(dark('--t2d-ghost'), bg), contrast(halo, bg)), `a dashed outline on ${on} ${bg}`).toBeGreaterThanOrEqual(3);
    }
    // A selected rake's end squares: the halo, edged in the rake's colour (purple is 2.5:1 on it)
    // and round that in a light edge (the probes' ink), which reads on the halo; on whatever is
    // under the square, its fill or one of its edges reads.
    expect(contrast(dark('--t2d-rake-2'), halo)).toBeLessThan(3);
    expect(contrast(dark('--t2d-probe'), halo)).toBeGreaterThanOrEqual(3);
    for (const rake of RAKE_TOKENS) {
      for (const [on, bg] of Object.entries({ ...under, ...bodies })) {
        const best = Math.max(contrast(halo, bg), contrast(dark(rake), bg), contrast(dark('--t2d-probe'), bg));
        expect(best, `${rake}'s end square on ${on} ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
    const text = ['--t2d-probe', '--t2d-select-ink', '--t2d-sketch-under', '--t2d-sketch-full', '--t2d-sketch-over', '--t2d-sketch-construction', '--t2d-sketch-pick'];
    for (const name of text) expect(contrast(dark(name), halo), `${name} ${dark(name)}`).toBeGreaterThanOrEqual(4.5);
    for (const name of ['--t2d-select', '--t2d-sketch-preview']) expect(contrast(dark(name), halo), name).toBeGreaterThanOrEqual(3);
    // The ring at the wall on the margins, and the swatches' ring on the dark panel and on its
    // hovered and selected rows (a swatch's colour may be fainter there than the ring).
    expect(contrast(dark('--t2d-wall'), margin)).toBeGreaterThanOrEqual(3);
    for (const row of ['--mg-bg', '--mg-surface-muted', '--mg-selected-bg']) {
      expect(contrast(dark('--t2d-swatch-ring'), dark(row)), `the swatches' ring on ${row} ${dark(row)}`).toBeGreaterThanOrEqual(3);
    }
  });
});
