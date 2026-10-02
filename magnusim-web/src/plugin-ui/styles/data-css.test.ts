import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkCssColours,
  checkCssDesignValues,
  checkCssSelectors,
  cssRules,
  readAppCss,
  readKitCss,
  ruleProps,
  withTokens,
} from '../../test/kitCss';

const css = readKitCss('data.css');
const appCss = readAppCss();
const residualPlot = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panels', 'run', 'ResidualPlot.tsx'), 'utf8');

describe('data.css', () => {
  // The parity gate's LinePlot pair compares the plot box, legend, swatch, line and
  // tip as drawn; these pin each copied rule, the cursor included, to its core rule.
  it('the line plot copies the core residual plot rules, value for value through the tokens', () => {
    const copies: Array<[kit: string, core: string]> = [
      ['.mgk-plot', '.sim-residual-wrap'],
      ['.mgk-plot-legend', '.sim-residual-legend'],
      ['.mgk-plot-swatch', '.sim-swatch'],
      ['.mgk-plot-cursor', '.sim-plot-cursor'],
      ['.mgk-plot-tip', '.sim-plot-tip'],
      ['b.mgk-plot-tip-head', '.sim-plot-tip b'],
    ];
    for (const [kit, core] of copies) {
      const coreProps = ruleProps(appCss, core);
      expect(Object.keys(coreProps).length, core).toBeGreaterThan(0);
      expect(withTokens(ruleProps(css, kit)), `${kit} = ${core}`).toEqual(coreProps);
    }
    expect(ruleProps(css, '.mgk-plot-cursor')['border-left']).toBe('1px dashed var(--mg-text-subtle)');
  });

  it('a dashed series is dashed as the core draws it (ResidualPlot strokeDasharray)', () => {
    expect(ruleProps(css, '.mgk-plot-line--dashed')).toEqual({ 'stroke-dasharray': '4 2' });
    expect(residualPlot).toContain("strokeDasharray={l.dashed ? '4 2' : undefined}");
    expect(ruleProps(css, '.mgk-plot-line')).toEqual({ fill: 'none', 'stroke-width': '1.5', 'stroke-linejoin': 'round' });
  });

  it('a hidden cursor or tip takes no room', () => {
    const rule = cssRules(css).find((r) => r.selectors.includes('.mgk-plot-cursor[hidden]'));
    expect(rule?.selectors).toEqual(['.mgk-plot-cursor[hidden]', '.mgk-plot-tip[hidden]']);
    expect(rule?.props).toEqual({ display: 'none' });
  });

  // ColorLegend is a new look (no core pair): its rules are pinned here.
  it('the colour legend: a 12 px bar with the core legend bar corners, its title and ticks', () => {
    expect(ruleProps(css, '.mgk-legend-bar')).toEqual({ height: '12px', 'border-radius': 'var(--mg-radius-2xs)' });
    const coreBar = ruleProps(appCss, '.legend-bar');
    expect(withTokens(ruleProps(css, '.mgk-legend-bar'))).toEqual({ height: coreBar.height, 'border-radius': coreBar['border-radius'] });
    expect(ruleProps(css, '.mgk-legend-title')).toEqual({
      'font-size': 'var(--mg-text-xs)',
      color: 'var(--mg-text-muted)',
      'margin-bottom': 'var(--mg-space-1)',
    });
    expect(ruleProps(css, '.mgk-legend-ticks')).toEqual({
      display: 'flex',
      'justify-content': 'space-between',
      'margin-top': '2px',
      'font-size': 'var(--mg-text-xs)',
      color: 'var(--mg-text-muted)',
      'font-variant-numeric': 'tabular-nums',
    });
  });

  it('the chart root takes the panel body colour', () => {
    expect(ruleProps(css, '.mgk-linechart')).toEqual({ color: 'var(--mg-text-body)' });
  });

  it('uses tokens for colours, sizes, weights and radii, and kit classes only', () => {
    // The gen check's rules (§2.9 rules 4, 6 and 9) on this file alone.
    expect(checkCssColours(css)).toEqual([]);
    expect(checkCssDesignValues(css)).toEqual([]);
    expect(checkCssSelectors(css)).toEqual([]);
    expect(checkCssColours(`${css}\n.mgk-plot-cursor { border-left: 1px dashed black; }`)).not.toEqual([]);
  });
});
