import { describe, expect, it } from 'vitest';
import { legendSeries } from './ResidualPlot';

describe('residual legend', () => {
  it('lists U and p, then only the turbulence equations this run solved', () => {
    expect(legendSeries([{ t: 1, U: 0.1, p: 0.2 }]).map((s) => s.label)).toEqual(['U', 'p']);
    expect(legendSeries([{ t: 1, U: 0.1, p: 0.2, k: 0.3, epsilon: 0.4 }]).map((s) => s.label)).toEqual(['U', 'p', 'k', 'ε']);
    expect(legendSeries([{ t: 1, U: 0.1, p: 0.2, epsilon: 0.4, R: 0.5 }]).map((s) => s.label)).toEqual(['U', 'p', 'ε', 'R']);
  });
});
