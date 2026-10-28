// The tunnel's tokens: the view's colours the GPU reads (src/app/colours.ts) are plain hex, which
// tokenRgb can read; the tokens built on the host's are declared again on any element with a theme
// of its own (the hidden light element the GPU, pictures and recordings read), so they take the
// host's light values there; and in light each colour is the one the tunnel drew before.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostLight, tokenReader, tunnel, tunnelBase } from './themeTokens';

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
};

describe('the tunnel tokens', () => {
  it('are declared on the page and again on any element with a theme of its own', () => {
    expect(tunnelBase.selectors).toEqual([':root', '[data-theme]']);
    // A token built on the host's resolves where it is declared: on the light element it takes
    // the light theme only because it is declared there too.
    for (const r of tunnel) {
      for (const [name, value] of Object.entries(r.props)) {
        if (value.includes('var(')) expect(r.selectors, name).toContain('[data-theme]');
      }
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
});
