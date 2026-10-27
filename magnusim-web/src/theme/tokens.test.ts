import { describe, expect, it } from 'vitest';
import { lightTokens, plan, planFonts, textTokens } from '../../scripts/theme-codemod.mjs';
import { seriesFor } from '../panels/run/ResidualPlot';
import { darkTokenValues, readAppCss, readTokensCss, ruleProps, tokenValues, withTokens } from '../test/kitCss';

const tokens = tokenValues();
const dark = darkTokenValues();
const appCss = readAppCss();

const isColour = (v: string) => /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v);

// WCAG 2 contrast of two #rrggbb colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const colourIn = (value: string) => (value.match(/#[0-9a-f]{3,8}\b/i) || [value])[0];
// transition: transform 0.15s → 150ms
const durationIn = (value: string) => {
  const m = value.match(/(\d*\.?\d+)(m?s)\b/);
  return m ? `${Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1))}ms` : value;
};

// H14's named core values (contract §3): each token and the core rule it was taken from.
const CORE_SOURCES: Array<[token: string, selector: string, prop: string, pick?: (v: string) => string]> = [
  ['--mg-primary', '.fp-btn-primary', 'background'],
  ['--mg-text-strong', '.switch input:checked + .slider', 'background'],
  ['--mg-text-body', '.mat-panel-body', 'color'],
  ['--mg-text-secondary', '.sim-eta', 'color'],
  ['--mg-divider', '.mat-panel-head', 'border-bottom', colourIn],
  ['--mg-card-border', '.tree-detail > .mat-panel', 'border', colourIn],
  ['--mg-control-border', '.fp-btn', 'border', colourIn],
  ['--mg-btn-neutral-bg', '.js-btn', 'background'],
  ['--mg-btn-neutral-hover', '.js-btn:hover', 'background'],
  ['--mg-btn-neutral-border', '.js-btn', 'border', colourIn],
  ['--mg-btn-disabled-bg', '.fp-btn-primary:disabled', 'background'],
  ['--mg-link', '.mat-clear-link', 'color'],
  ['--mg-link-strong', '[data-run-reason] .sim-fix-go', 'color'],
  ['--mg-link-strong-hover', '[data-run-reason] .sim-fix-go:hover', 'color'],
  ['--mg-danger-solid', '.home-btn-danger', 'background'],
  ['--mg-danger-solid-hover', '.home-btn-danger:hover', 'background'],
  ['--mg-switch-off', '.switch .slider', 'background'],
  ['--mg-tooltip-bg', '.mat-k-tip', 'background'],
  ['--mg-tooltip-text', '.mat-k-tip', 'color'],
  ['--mg-plot-bg', '.sim-residual-wrap', 'background'],
  ['--mg-plot-tip-bg', '.sim-plot-tip', 'background'],
  ['--mg-text-3xs', '.mat-k-help', 'font-size'],
  ['--mg-text-2xs', '.sim-plot-tip', 'font-size'],
  ['--mg-weight-bold', '.mat-k-help', 'font-weight'],
  ['--mg-line-tight', '.sim-plot-tip', 'line-height'],
  ['--mg-radius-2xs', '.legend-bar', 'border-radius'],
  ['--mg-radius-xs', '.js-btn', 'border-radius'],
  ['--mg-radius-tip', '.mat-k-tip', 'border-radius'],
  ['--mg-radius-round', '.switch .slider::before', 'border-radius'],
  ['--mg-shadow-xs', '.sim-plot-tip', 'box-shadow'],
  ['--mg-shadow-tooltip', '.mat-k-tip', 'box-shadow'],
  ['--mg-disabled-opacity', '.fp-btn:disabled', 'opacity'],
  ['--mg-duration-switch', '.switch .slider::before', 'transition', durationIn],
  ['--mg-z-tooltip', '.mat-k-tip', 'z-index'],
];

describe('tokens.css', () => {
  it('each named core value equals the core rule it comes from (style.css, through its tokens)', () => {
    for (const [token, selector, prop, pick] of CORE_SOURCES) {
      const raw = ruleProps(appCss, selector)[prop];
      expect(raw, `${selector} { ${prop} }`).toBeDefined();
      const core = withTokens({ [prop]: raw })[prop];
      expect(tokens[token], token).toBe(pick ? pick(core) : core);
    }
  });

  it('the dark set gives every light colour a dark value, and changes nothing but colours and shadows', () => {
    const lightColours = Object.keys(tokens).filter((k) => isColour(tokens[k]));
    expect(lightColours.length).toBeGreaterThan(60);
    expect(lightColours.filter((k) => !(k in dark))).toEqual([]);
    for (const [k, v] of Object.entries(dark)) {
      expect(k in tokens, `${k} is a light token too`).toBe(true);
      expect(isColour(v) || k.startsWith('--mg-shadow-'), `${k}: ${v}`).toBe(true);
    }
    expect(readTokensCss()).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  });

  // Text on the surfaces it sits on: at least 4.5:1 in dark, or as readable as light where light is
  // below that (the placeholder greys). The fills: their text on them, both themes.
  it('dark text is readable on every surface, at least as readable as light', () => {
    const texts = ['text', 'text-strong', 'text-body', 'text-secondary', 'text-muted', 'text-subtle', 'text-tertiary', 'text-dim', 'text-slate', 'text-faint', 'link', 'link-strong', 'primary-ink', 'danger', 'success', 'warning', 'info'];
    const surfaces = ['bg', 'surface', 'surface-muted', 'surface-2', 'surface-3', 'surface-hover', 'app-bg', 'selected-bg'];
    const fills = [['primary-text', 'primary'], ['primary-text', 'primary-hover'], ['primary-text', 'danger-solid'], ['tooltip-text', 'tooltip-bg'], ['danger', 'danger-bg'], ['success', 'success-bg'], ['warning', 'warning-bg'], ['text', 'btn-neutral-bg'], ['text', 'btn-neutral-hover']];
    const pairs = [...texts.flatMap((t) => surfaces.map((s) => [t, s])), ...fills];
    const value = (set: Record<string, string>, k: string) => set[`--mg-${k}`] ?? tokens[`--mg-${k}`];
    const short = [];
    for (const [t, s] of pairs) {
      const light = contrast(value(tokens, t), value(tokens, s));
      const darkRatio = contrast(value(dark, t), value(dark, s));
      if (darkRatio < Math.min(4.5, light)) short.push(`${t} on ${s}: ${darkRatio.toFixed(2)} (light ${light.toFixed(2)})`);
    }
    expect(short).toEqual([]);
    for (const [t, s] of fills.slice(0, 4)) expect(contrast(value(tokens, t), value(tokens, s)), `${t} on ${s}, light`).toBeGreaterThanOrEqual(4.5);
  });

  // The ratchet: style.css paints with tokens. A colour with a token's value must use the token, a
  // new colour with no token is refused (the count only goes down), and every font size scales.
  it('style.css uses a token for every colour that has one, adds no other colour literal, and has no px font size', () => {
    const tokensCss = readTokensCss();
    const { edits, skipped } = plan(appCss, lightTokens(tokensCss));
    expect(edits.map((e: { line: number; literal: string; to: string }) => `${e.line}: ${e.literal} -> ${e.to}`)).toEqual([]);
    expect(skipped.length).toBeLessThanOrEqual(415);
    expect(planFonts(appCss, textTokens(tokensCss)).map((e: { line: number; literal: string }) => `${e.line}: ${e.literal}`)).toEqual([]);
  });

  it('the hover and solid danger values differ from their resting values', () => {
    expect(tokens['--mg-danger-solid-hover']).not.toBe(tokens['--mg-danger-solid']);
    expect(tokens['--mg-btn-neutral-hover']).not.toBe(tokens['--mg-btn-neutral-bg']);
    expect(tokens['--mg-link-strong-hover']).not.toBe(tokens['--mg-link-strong']);
  });

  it('--mg-series-1 … 7 are the residual plot colours, in order', () => {
    const row = Object.fromEntries([['t', 1], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [`s${i}`, 1])]);
    const core = seriesFor([row], []).map((s) => s.color);
    expect(core).toHaveLength(7);
    expect([1, 2, 3, 4, 5, 6, 7].map((i) => tokens[`--mg-series-${i}`])).toEqual(core);
  });
});
