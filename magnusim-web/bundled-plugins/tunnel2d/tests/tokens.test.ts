// The tunnel's tokens: the view's colours the GPU reads (src/app/colours.ts) are plain hex, which
// tokenRgb can read, and the tokens built on the host's are declared again on the stage (its
// data-theme keeps the light theme), so they resolve to the host's light values there.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...parts: string[]) => readFileSync(join(__dirname, ...parts), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Each rule of a stylesheet: its selectors and its custom properties. */
function rules(css: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()),
    props: Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])),
  }));
}

const tunnel = rules(read('..', 'src', 'styles', 'tokens.css'));
const host = rules(read('..', '..', '..', 'src', 'theme', 'tokens.css'));
const coloursTs = readFileSync(join(__dirname, '..', 'src', 'app', 'colours.ts'), 'utf8');
const hostLight = host.find((r) => r.selectors.includes('[data-theme="light"]'))!;
const tunnelBlock = tunnel.find((r) => '--t2d-bg' in r.props)!;

// The tunnel tokens colours.ts reads; the rheoscopic presets' are built from the preset's name.
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

describe('the tunnel tokens', () => {
  it('are declared on the page and again on any element with a theme of its own (the stage)', () => {
    expect(tunnelBlock.selectors).toEqual([':root', '[data-theme]']);
    // A token built on the host's resolves where it is declared: on the stage it takes the
    // stage's theme only because it is declared there too.
    for (const r of tunnel) {
      for (const [name, value] of Object.entries(r.props)) {
        if (value.includes('var(')) expect(r.selectors, name).toContain('[data-theme]');
      }
    }
  });

  it('that colours.ts reads for the GPU are this list, each a plain hex colour', () => {
    const literal = [...coloursTs.matchAll(/--t2d-[a-z0-9-]+(?=['`])/g)].map((m) => m[0]);
    expect([...new Set(literal)].sort()).toEqual([...GPU_TOKENS].sort());
    expect([...coloursTs.matchAll(/look\('([a-z]+)'/g)].map((m) => m[1])).toEqual(RHEO_PRESETS);
    expect(coloursTs).toContain('`--t2d-rheo-${name}-base`');
    expect(coloursTs).toContain('`--t2d-rheo-${name}-light1`');
    expect(coloursTs).toContain('`--t2d-rheo-${name}-light2`');
    for (const name of [...GPU_TOKENS, ...RHEO_TOKENS]) expect(tunnelBlock.props[name], name).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("the host's series colours the rakes take are plain hex in every theme", () => {
    expect(coloursTs).toContain('`--mg-series-${i}`');
    const blocks = host.filter((r) => '--mg-series-1' in r.props);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const r of blocks) {
      for (let i = 1; i <= 6; i++) expect(r.props[`--mg-series-${i}`], `${r.selectors.join(', ')} --mg-series-${i}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("built on the host's take the host's light values on the light stage", () => {
    expect(hostLight.selectors).toContain(':root');
    for (const [name, value] of Object.entries(tunnelBlock.props)) {
      const ref = /^var\((--mg-[\w-]+)\)$/.exec(value);
      if (value.includes('var(')) expect(ref, name).not.toBeNull();
      if (ref) expect(hostLight.props[ref[1]], `${name}: ${value}`).toBeDefined();
    }
    // The selection was #1570ef before it followed the host's primary.
    expect(tunnelBlock.props['--t2d-select']).toBe('var(--mg-primary)');
    expect(hostLight.props['--mg-primary']).toBe('#1570ef');
  });
});
