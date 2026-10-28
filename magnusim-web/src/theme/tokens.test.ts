import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lightTokens, normalize, plan, planFonts, textTokens } from '../../scripts/theme-codemod.mjs';
import { resolveVars } from '../../scripts/theme-light-identity.mjs';
import { seriesFor } from '../panels/run/ResidualPlot';
import { LIGHT_SERIES } from './series';
import { cssRules, darkTokenValues, readAppCss, readTokensCss, ruleProps, tokenValues, withTokens } from '../test/kitCss';

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

// The 3D view's surface and pick tokens (and the BC, refinement and analysis-area colours its faces
// share with the chrome's swatches): the same in every theme (Daniel, 2026-10-27: the model's surfaces
// stay light on the dark view). Its lines, edges, points and labels' glow have dark values (DARK_VIEW).
const VIEW_TOKENS = [
  ...['face', 'face-dim', 'mesh-face', 'slice-face', 'selected', 'pick', 'pick-strong', 'candidate', 'region', 'marker', 'flash'].map((n) => `--mg-viewport-${n}`),
  '--mg-capture-mask',
  ...['inlet', 'outlet', 'pressure', 'freestream', 'wall', 'symmetry', 'other', 'default'].map((n) => `--mg-bc-${n}`),
  '--mg-ref-surface',
  '--mg-ref-inflate',
  '--mg-accent-purple',
];

// The appearance tokens for the rest of the chrome, the charts and the 3D view, with the light
// value each takes: the colour the app paints there today, so the light look stays the same.
const APPEARANCE_LIGHT: Record<string, string> = {
  '--mg-text-ink': '#1f2430',
  '--mg-overlay-bg': 'rgba(20, 24, 32, 0.5)',
  '--mg-info-bg': '#eef3fd',
  '--mg-info-border': '#c5d4f5',
  '--mg-active-bg': '#d7e8ff',
  '--mg-active-border': '#9bc2f0',
  '--mg-pressed-border': '#6ea3ea',
  '--mg-pressed-text': '#143a6b',
  '--mg-success-border': '#abefc6',
  '--mg-success-bg-strong': '#d1fadf',
  '--mg-success-muted': '#3f6b4a',
  '--mg-warning-border': '#fedf89',
  '--mg-accent-purple-bg': '#ebe9fe',
  '--mg-running': '#12b76a',
  '--mg-legend-lo': '#2438d6',
  '--mg-legend-hi': '#c01818',
  '--mg-pin': '#c026d3',
  '--mg-pin-text': '#a21caf',
  '--mg-btn-solid-bg': '#1a1d24',
  '--mg-btn-solid-hover': '#2a3140',
  '--mg-btn-solid-text': '#ffffff',
  '--mg-inverse-hover': '#1d2939',
  '--mg-border-soft': '#dde1e8',
  '--mg-shadow-lg': '0 12px 40px rgba(0, 0, 0, 0.25)',
  '--mg-tooltip-edge': 'transparent',
  '--mg-gradient-edge': 'transparent',
  '--mg-chart-grid': '#e6e9ef',
  '--mg-chart-axis': '#98a2b3',
  '--mg-chart-text': '#667085',
  '--mg-series-8': '#d92d20',
  '--mg-series-9': '#7a5af8',
  '--mg-series-10': '#0e9384',
  '--mg-series-11': '#dc6803',
  '--mg-series-default': '#3884e6',
  '--mg-series-lift': '0%',
  '--mg-viewport-ink': '#141a29',
  '--mg-viewport-edge': '#0a0b0e',
  '--mg-viewport-mesh-edge': '#42474f',
  '--mg-viewport-face': '#bdc9db',
  '--mg-viewport-face-dim': '#bcc4d0',
  '--mg-viewport-mesh-face': '#dbe0e8',
  '--mg-viewport-slice-face': '#d1d9e3',
  '--mg-viewport-selected': '#4884eb',
  '--mg-viewport-pick': '#2ec47e',
  '--mg-viewport-pick-strong': '#1ad675',
  '--mg-viewport-candidate': '#7688a2',
  '--mg-viewport-region': '#fab81f',
  '--mg-viewport-marker': '#ff00ff',
  '--mg-viewport-flash': '#ff8c14',
  '--mg-viewport-halo': '#ffffff',
  '--mg-capture-mask': 'rgba(18, 22, 32, 0.42)',
  '--mg-bc-inlet': '#3884e6',
  '--mg-bc-outlet': '#ea7024',
  '--mg-bc-pressure': '#9333ea',
  '--mg-bc-freestream': '#16a34a',
  '--mg-bc-wall': '#5f6b7a',
  '--mg-bc-symmetry': '#0891b2',
  '--mg-bc-other': '#db2777',
  '--mg-bc-default': '#d6be8c',
  '--mg-ref-surface': '#0d9488',
  '--mg-ref-inflate': '#d97706',
  '--mg-accent-purple': '#6941c6',
};

describe('tokens.css', () => {
  it('each named core value equals the core rule it comes from (style.css, through its tokens)', () => {
    for (const [token, selector, prop, pick] of CORE_SOURCES) {
      const raw = ruleProps(appCss, selector)[prop];
      expect(raw, `${selector} { ${prop} }`).toBeDefined();
      const core = withTokens({ [prop]: raw })[prop];
      expect(tokens[token], token).toBe(pick ? pick(core) : core);
    }
  });

  it("the dark set gives every light colour a dark value (the 3D view's surfaces keep theirs), and changes nothing but colours and shadows", () => {
    const lightColours = Object.keys(tokens).filter((k) => isColour(tokens[k]));
    expect(lightColours.length).toBeGreaterThan(60);
    expect(lightColours.filter((k) => !(k in dark) && !VIEW_TOKENS.includes(k))).toEqual([]);
    // The 3D view's surfaces and picks are the same in every theme.
    expect(VIEW_TOKENS.filter((k) => !(k in tokens) || k in dark)).toEqual([]);
    for (const [k, v] of Object.entries(dark)) {
      expect(k in tokens, `${k} is a light token too`).toBe(true);
      // --mg-series-lift is a colour amount: how far a series with no token lifts toward white.
      expect(isColour(v) || k.startsWith('--mg-shadow-') || k === '--mg-series-lift', `${k}: ${v}`).toBe(true);
    }
    expect(readTokensCss()).toMatch(/\[data-theme="dark"\]\s*\{\s*color-scheme: dark;/);
  });

  it('the appearance tokens have the light value the app paints today', () => {
    for (const [k, v] of Object.entries(APPEARANCE_LIGHT)) expect(tokens[k], k).toBe(v);
    const chromeAndCharts = Object.keys(APPEARANCE_LIGHT).filter((k) => !VIEW_TOKENS.includes(k));
    expect(chromeAndCharts.filter((k) => !(k in dark))).toEqual([]);
  });

  it("the dark 3D view: lines and points read on its background, edges on the background and the light faces, mesh edges on the mesh faces, the labels' glow is the background", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bg = dark['--mg-viewport-bg'];
    expect(contrast(dark['--mg-viewport-ink'], bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark['--mg-viewport-edge'], bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark['--mg-viewport-edge'], tokens['--mg-viewport-face'])).toBeGreaterThanOrEqual(2.5);
    expect(contrast(dark['--mg-viewport-mesh-edge'], tokens['--mg-viewport-mesh-face'])).toBeGreaterThanOrEqual(4.5);
    expect(dark['--mg-viewport-halo']).toBe(bg);
    for (const axis of ['x', 'y', 'z']) expect(contrast(dark[`--mg-axis-${axis}`], bg), axis).toBeGreaterThanOrEqual(3);
    expect(contrast(dark['--mg-pin'], bg)).toBeGreaterThanOrEqual(3);
  });

  it("fields and ticks no rule colours are the browser's own in light, a select's and the primary in dark", () => {
    // Chromium's light Field, FieldText and accent: what an uncoloured input showed before.
    expect([tokens['--mg-field-bg'], tokens['--mg-field-text'], tokens['--mg-check-accent']]).toEqual(['#ffffff', '#000000', 'auto']);
    expect([dark['--mg-field-bg'], dark['--mg-field-text'], dark['--mg-check-accent']]).toEqual([dark['--mg-bg'], dark['--mg-text'], dark['--mg-primary']]);
    // Fields in dark only (a colour set in light turns the browser's own field look off), the kit's
    // field with them; ticks in both (auto in light). Each but the kit's below every class rule (:where).
    const rules = cssRules(appCss).filter((r) => Object.values(r.props).some((v) => /var\(--mg-(field|check)-/.test(String(v))));
    expect(rules.map((r) => [r.selectors.join(', ').slice(0, 34), r.props])).toEqual([
      [':where([data-theme="dark"]) :where', { 'background-color': 'var(--mg-field-bg)', color: 'var(--mg-field-text)' }],
      [':where([data-theme="dark"]) input.', { 'background-color': 'var(--mg-field-bg)', color: 'var(--mg-field-text)' }],
      [':where(input[type="checkbox"], inp', { 'accent-color': 'var(--mg-check-accent)' }],
    ]);
  });

  // vtk, canvas and WebGPU read these through themeColor (src/theme/themeColor.ts), which takes rgb()
  // only: a color-mix() computes to color(srgb ...).
  it('every token code reads as a colour is plain hex or rgb in every block', () => {
    const read = (k: string) => /^--mg-(viewport-|bc-|ref-|axis-)/.test(k) || k === '--mg-capture-mask' || k === '--mg-accent-purple';
    const names = Object.keys(tokens).filter(read);
    expect(names.length).toBeGreaterThan(30);
    for (const k of names) {
      expect(isColour(tokens[k]), `${k}: ${tokens[k]}`).toBe(true);
      if (k in dark) expect(isColour(dark[k]), `${k} (dark): ${dark[k]}`).toBe(true);
    }
  });

  // tunnel2d's view colours, read as colours by its WebGPU palette and its 2D overlays: several are
  // built on the host's tokens, so each is taken through the host's light and dark values.
  it('every tunnel2d colour token is plain hex or rgb on the light and dark tokens', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bundled-plugins', 'tunnel2d', 'src', 'styles', 'tokens.css'), 'utf8');
    const t2d = cssRules(css).flatMap((r) => Object.entries(r.props)).filter(([k]) => k.startsWith('--t2d-'));
    const lightMap = new Map([...Object.entries(tokens), ...t2d]);
    const darkMap = new Map([...Object.entries({ ...tokens, ...dark }), ...t2d]);
    const colours = t2d.filter(([, v]) => !/^\d+(\.\d+)?px$/.test(resolveVars(v, lightMap)));
    expect(colours.length).toBeGreaterThan(25);
    for (const [k, v] of colours) {
      for (const [theme, map] of [['light', lightMap], ['dark', darkMap]] as const) {
        const value = resolveVars(v, map);
        expect(isColour(value), `${k} (${theme}): ${v} -> ${value}`).toBe(true);
      }
    }
  });

  // e2e/shared-face-ids.spec.js finds the painted faces as "not the most common colour".
  it('the CAD face greys differ from every BC, refinement and pick colour', () => {
    const paints = Object.keys(tokens).filter((k) => /^--mg-(bc-|ref-|viewport-(pick|selected|candidate|region))/.test(k) || k === '--mg-accent-purple');
    expect(paints.length).toBeGreaterThan(12);
    for (const face of ['--mg-viewport-face', '--mg-viewport-face-dim']) {
      for (const p of paints) expect(tokens[p], `${face} vs ${p}`).not.toBe(tokens[face]);
    }
  });

  // Text on the surfaces it sits on: at least 4.5:1 in dark, or as readable as light where light is
  // below that (the placeholder greys). The fills: their text on them, both themes.
  it('dark text is readable on every surface, at least as readable as light', () => {
    const texts = ['text', 'text-strong', 'text-body', 'text-secondary', 'text-muted', 'text-subtle', 'text-tertiary', 'text-dim', 'text-slate', 'text-faint', 'text-ink', 'link', 'link-strong', 'primary-ink', 'danger', 'success', 'warning', 'info'];
    const surfaces = ['bg', 'surface', 'surface-muted', 'surface-2', 'surface-3', 'surface-hover', 'app-bg', 'selected-bg'];
    const fills = [
      ['primary-text', 'primary'], ['primary-text', 'primary-hover'], ['primary-text', 'danger-solid'], ['tooltip-text', 'tooltip-bg'],
      ['danger', 'danger-bg'], ['success', 'success-bg'], ['warning', 'warning-bg'], ['text', 'btn-neutral-bg'], ['text', 'btn-neutral-hover'],
      ['btn-solid-text', 'btn-solid-bg'], ['btn-solid-text', 'btn-solid-hover'], ['pressed-text', 'active-bg'], ['text-ink', 'info-bg'],
    ];
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
    const { edits, skipped, fixed } = plan(appCss, lightTokens(tokensCss));
    expect(edits.map((e: { line: number; literal: string; to: string }) => `${e.line}: ${e.literal} -> ${e.to}`)).toEqual([]);
    const lines = appCss.split('\n');
    const ruleAt = (line: number) => {
      for (let i = line - 1; i >= 0; i--) {
        const open = lines[i].lastIndexOf('{');
        if (open >= 0) return lines[i].slice(0, open).trim();
      }
      return '';
    };
    type Left = { line: number; prop: string; literal: string; reason: string };
    const byRule = (f: { line: number; prop: string; literal: string }) => `${ruleAt(f.line)} { ${f.prop}: ${f.literal} }`;
    // A var() fallback that is its own token's light value is the token's colour before tokens.css
    // arrives (index.html links style.css, the entry script brings tokens.css): not a colour of its
    // own, so out of the count and listed.
    const ownToken = (s: Left) => {
      if (s.reason !== 'a var() fallback') return false;
      const lit = s.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const name = new RegExp(`var\\((--mg-[a-z0-9-]+)\\s*,\\s*${lit}\\s*\\)`).exec(lines[s.line - 1])?.[1];
      return !!name && name in tokens && normalize(tokens[name]) === normalize(s.literal);
    };
    expect(skipped.filter(ownToken).map(byRule)).toEqual(['#app { background: #e8eaee }']);
    expect(skipped.filter((s: Left) => !ownToken(s)).length).toBeLessThanOrEqual(35);
    // A literal marked "fixed" (the same in every theme) is out of the count above, so each one is
    // listed here: a new one is a deliberate change to this list. By rule, as lines move.
    expect(fixed.map(byRule)).toEqual([
      '.pt-rh-dot { border: #fff }',
      '.capture-frame { border: #fff }',
      '.cfr-corner { background: #fff }',
    ]);
    expect(planFonts(appCss, textTokens(tokensCss)).map((e: { line: number; literal: string }) => `${e.line}: ${e.literal}`)).toEqual([]);
  });

  it('the hover and solid danger values differ from their resting values', () => {
    expect(tokens['--mg-danger-solid-hover']).not.toBe(tokens['--mg-danger-solid']);
    expect(tokens['--mg-btn-neutral-hover']).not.toBe(tokens['--mg-btn-neutral-bg']);
    expect(tokens['--mg-link-strong-hover']).not.toBe(tokens['--mg-link-strong']);
  });

  it('--mg-series-1 … 7 are the residual plot colours, in order (three a darker light value: LIGHT_SERIES)', () => {
    const row = Object.fromEntries([['t', 1], ...[1, 2, 3, 4, 5, 6, 7].map((i) => [`s${i}`, 1])]);
    const core = seriesFor([row], []).map((s) => s.color);
    expect(core).toHaveLength(7);
    expect([1, 2, 3, 4, 5, 6, 7].map((i) => tokens[`--mg-series-${i}`])).toEqual(core.map((c) => LIGHT_SERIES[c] ?? c));
  });
});
