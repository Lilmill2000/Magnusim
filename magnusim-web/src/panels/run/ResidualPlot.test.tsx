import { describe, expect, it } from 'vitest';
import { legendSeries, plotGeometry, seriesFor, type ResidualSeries } from './ResidualPlot';

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
