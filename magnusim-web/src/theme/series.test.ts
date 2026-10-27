import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lightValue } from '../../scripts/theme-light-identity.mjs';
import { seriesFor } from '../panels/run/ResidualPlot';
import { darkTokenValues, tokenValues } from '../test/kitCss';
import { SERIES_TOKENS, seriesVar } from './series';

const light = tokenValues();
const dark = darkTokenValues();
const lightTokens = new Map(Object.entries(light));

// The series colours the plugins declare (scripts/generated/registry.json): every "color" in it.
function registryColours(): string[] {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'generated', 'registry.json'), 'utf8');
  return [...new Set([...text.matchAll(/"color"\s*:\s*"(#[0-9a-fA-F]{3,8})"/g)].map((m) => m[1].toLowerCase()))];
}

describe('seriesVar', () => {
  it('maps every series colour the plugins declare and the core draws to its token', () => {
    const plugins = registryColours();
    expect(plugins.length).toBeGreaterThanOrEqual(10);
    const row = Object.fromEntries([['t', 1], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [`s${i}`, 1])]);
    // The residual plot's own colours, the monitor chart's default series and Plot Over Path's line.
    const core = [...seriesFor([row], []).map((s) => s.color), '#3884e6', '#1570ef'];
    for (const hex of [...plugins, ...core]) expect(seriesVar(hex), hex).toMatch(/^var\(--mg-series-[\w-]+\)$/);
  });

  it("each token's light value is its hex, and it has a dark value", () => {
    for (const [hex, token] of Object.entries(SERIES_TOKENS)) {
      expect(light[token], token).toBe(hex);
      expect(dark[token], token).toMatch(/^#[0-9a-f]{6}$/);
      expect(seriesVar(hex.toUpperCase())).toBe(`var(${token})`);
    }
  });

  it('lifts any other hex toward white by --mg-series-lift, which in light gives the hex exactly', () => {
    const v = seriesVar('#123456');
    expect(v).toBe('color-mix(in srgb, #123456 calc(100% - var(--mg-series-lift)), white)');
    expect(light['--mg-series-lift']).toBe('0%');
    expect(dark['--mg-series-lift']).toBe('30%');
    expect(lightValue(v, lightTokens)).toBe('#123456');
    expect(lightValue(seriesVar('#abc'), lightTokens)).toBe('#aabbcc');
    expect(lightValue(v, new Map([...lightTokens, ['--mg-series-lift', dark['--mg-series-lift']]]))).not.toBe('#123456');
  });

  it('leaves a colour that is not a hex as it is', () => {
    expect(seriesVar('var(--mg-series-2)')).toBe('var(--mg-series-2)');
    expect(seriesVar('currentColor')).toBe('currentColor');
  });
});
