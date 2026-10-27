import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seriesVar } from '../../theme/series';
import { ResidualPlot, legendGroups, legendSeries, plotGeometry, residualRegions, seriesFor, type ResidualSeries } from './ResidualPlot';

afterEach(() => vi.restoreAllMocks());

const SERIES: ResidualSeries[] = [
  { key: 'a', label: 'A', color: '#111111', always: true },
  { key: 'b', label: 'B', color: '#222222', always: true },
  { key: 'c', label: 'C', color: '#333333' },
  { key: 'd', label: 'D', color: '#444444' },
  { key: 'm', label: 'M mean', color: '#555555', dashed: true, max_key: 'm_max' },
];

describe('residual legend', () => {
  it('lists the always-shown series, then only the ones this run solved', () => {
    expect(legendSeries([{ t: 1, a: 0.1, b: 0.2 }], SERIES).map((s) => s.label)).toEqual(['A', 'B']);
    expect(legendSeries([{ t: 1, a: 0.1, b: 0.2, d: 0.4 }], SERIES).map((s) => s.label)).toEqual(['A', 'B', 'D']);
  });

  it('draws a dashed metric only when the run has one', () => {
    expect(plotGeometry([{ t: 1, a: 0.1 }], 10, false, SERIES)?.metrics).toEqual([]);
    const geo = plotGeometry([{ t: 1, a: 0.1, m: 0.3 }], 10, true, SERIES);
    expect(geo?.metrics.map((s) => s.key)).toEqual(['m']);
    expect(geo?.lines.find((l) => l.key === 'm')?.dashed).toBe(true);
  });

  it('falls back to one series per number when the analysis declares none', () => {
    expect(seriesFor([{ t: 1, x: 0.1, y: 0.2 }], []).map((s) => s.key)).toEqual(['x', 'y']);
  });
});

// A multi-region run (host API 1.8): residuals keyed <region>:<field>, grouped by region.
const CHT_ROWS = [
  { t: 1, 'air:U': 1, 'air:h': 0.9, 'heater:h': 0.4, m: 0.2 },
  { t: 2, 'air:U': 0.5, 'air:h': 0.3, 'heater:h': 0.1, m: 0.3 },
];

describe('residuals of a multi-region run', () => {
  it('reads the regions from the row keys', () => {
    expect(residualRegions(CHT_ROWS)).toEqual(['air', 'heater']);
    expect(residualRegions([{ t: 1, a: 1 }])).toEqual([]);
  });

  it('never gives a second region a color a declared series has', () => {
    // The stub CHT analysis declares U and p_rgh in the first two fallback colors.
    const declared: ResidualSeries[] = [
      { key: 'U', label: 'U', color: '#1570EF', always: true },
      { key: 'h', label: 'h', color: '#b42318', always: true },
      { key: 'p_rgh', label: 'p_rgh', color: '#6941c6', always: true },
    ];
    const rows = [{ t: 1, 'air:U': 0.1, 'air:h': 0.2, 'air:p_rgh': 0.3, 'solid:h': 0.4 }];
    const series = seriesFor(rows, declared);
    const own = series.filter((s) => s.region === 'solid').map((s) => s.color.toLowerCase());
    for (const c of own) expect(['#1570ef', '#b42318', '#6941c6']).not.toContain(c);
    expect(new Set(own).size).toBe(own.length);
  });

  it('draws each declared series once per region, the dashed metric once', () => {
    const declared: ResidualSeries[] = [
      { key: 'U', label: 'U', color: '#111111', always: true },
      { key: 'h', label: 'h', color: '#222222', always: true },
      SERIES[4],
    ];
    const series = seriesFor(CHT_ROWS, declared);
    expect(series.map((s) => [s.key, s.label, s.region])).toEqual([
      ['air:U', 'U', 'air'],
      ['air:h', 'h', 'air'],
      ['heater:U', 'U', 'heater'],
      ['heater:h', 'h', 'heater'],
      ['m', 'M mean', undefined],
    ]);
    // The first region keeps the declared colors; the others get colors of their own.
    expect(series[0].color).toBe('#111111');
    expect(new Set(series.slice(0, 4).map((s) => s.color)).size).toBe(4);
    // heater solves no U: its legend leaves it out.
    const groups = legendGroups(legendSeries(CHT_ROWS, series));
    expect(groups.map((g) => [g.region, g.series.map((s) => s.label)])).toEqual([
      ['air', ['U', 'h']],
      ['heater', ['h']],
    ]);
    expect(plotGeometry(CHT_ROWS, 2, false, series)?.lines.map((l) => l.key)).toEqual(['air:U', 'air:h', 'heater:h', 'm']);
  });

  it('labels undeclared region keys by field, grouped by region', () => {
    const series = seriesFor([{ t: 1, 'air:h': 0.5, 'solid:h': 0.2 }], []);
    expect(series.map((s) => [s.key, s.label, s.region])).toEqual([
      ['air:h', 'h', 'air'],
      ['solid:h', 'h', 'solid'],
    ]);
  });

  it('shows the legend in one group per region', () => {
    const declared: ResidualSeries[] = [{ key: 'h', label: 'h', color: '#222222', always: true }];
    const { container } = render(<ResidualPlot rows={CHT_ROWS} endTime={2} seconds={false} series={declared} />);
    const groups = [...container.querySelectorAll('[data-residual-region]')];
    expect(groups.map((g) => g.getAttribute('data-residual-region'))).toEqual(['air', 'heater']);
    expect(groups.map((g) => g.textContent)).toEqual(['airh', 'heaterh']);
  });
});

// The plot follows the theme: each series through its --mg-series-* token (the hex stays its
// identity), the grid and labels through the kit's plot classes. Light values are the old ones.
describe('residual plot colours', () => {
  const series: ResidualSeries[] = [
    { key: 'u', label: 'U', color: '#1570EF', always: true },
    { key: 'p', label: 'p', color: '#6941c6', always: true },
    { key: 'h', label: 'h', color: '#222222', always: true },
  ];
  const rows = [
    { t: 1, u: 0.5, p: 0.4, h: 0.2 },
    { t: 2, u: 0.1, p: 0.08, h: 0.05 },
  ];

  it('paints no fixed colour: SVG attributes take no var(), so colours come from classes and styles', () => {
    const { container } = render(<ResidualPlot rows={rows} endTime={2} seconds={false} series={series} />);
    const svg = container.querySelector('svg') as SVGSVGElement;
    for (const el of svg.querySelectorAll('*')) {
      for (const attr of ['stroke', 'fill']) expect([null, 'none'], `${el.tagName} ${attr}`).toContain(el.getAttribute(attr));
    }
    const grid = [...svg.querySelectorAll('line')];
    expect(grid.length).toBeGreaterThan(0);
    for (const line of grid) expect(line.getAttribute('class')).toBe('mgk-plot-grid');
    const labels = [...svg.querySelectorAll('text')];
    expect(labels.length).toBe(grid.length + 2);
    for (const text of labels) expect(text.getAttribute('class')).toBe('mgk-plot-label');
    const lines = [...svg.querySelectorAll('polyline')];
    expect(lines.map((l) => l.style.stroke)).toEqual(['var(--mg-series-1)', 'var(--mg-series-2)', seriesVar('#222222')]);
    expect(seriesVar('#222222')).toContain('var(--mg-series-lift)');
  });

  it('draws the legend swatches and the tip names in the series tokens', () => {
    // jsdom lays nothing out: the plot is 280 px wide, one px per viewBox unit.
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 280, bottom: 132, width: 280, height: 132, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    const { container } = render(<ResidualPlot rows={rows} endTime={2} seconds={false} series={series.slice(0, 2)} />);
    const swatches = [...container.querySelectorAll('.sim-residual-legend i.sim-swatch')] as HTMLElement[];
    expect(swatches.map((s) => s.style.background)).toEqual(['var(--mg-series-1)', 'var(--mg-series-2)']);
    fireEvent.pointerMove(container.querySelector('.sim-residual-wrap') as Element, { clientX: 140, clientY: 60 });
    const names = [...container.querySelectorAll('.sim-plot-tip span > span')] as HTMLElement[];
    expect(names.map((n) => [n.textContent, n.style.color])).toEqual([
      ['U', 'var(--mg-series-1)'],
      ['p', 'var(--mg-series-2)'],
    ]);
  });
});
