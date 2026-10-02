import { describe, expect, it } from 'vitest';
import { seriesFor } from '../panels/run/ResidualPlot';
import { readAppCss, ruleProps, tokenValues } from '../test/kitCss';

const tokens = tokenValues();
const appCss = readAppCss();

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
  it('each named core value equals the core rule it comes from (style.css)', () => {
    for (const [token, selector, prop, pick] of CORE_SOURCES) {
      const core = ruleProps(appCss, selector)[prop];
      expect(core, `${selector} { ${prop} }`).toBeDefined();
      expect(tokens[token], token).toBe(pick ? pick(core) : core);
    }
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
