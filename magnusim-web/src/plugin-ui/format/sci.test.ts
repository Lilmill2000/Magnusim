import { describe, expect, it } from 'vitest';
import { formatSci, parseSci } from './sci';
import * as core from '../../forms/SciNumberInput';

describe('formatSci and parseSci', () => {
  it('shows tiny and huge magnitudes in exponent form, the rest to six digits', () => {
    expect(formatSci(null)).toBe('');
    expect(formatSci(undefined)).toBe('');
    expect(formatSci(Number.NaN)).toBe('');
    expect(formatSci(0)).toBe('0');
    expect(formatSci(1.529e-5)).toBe('1.5290e-5');
    expect(formatSci(2.5e6)).toBe('2.5000e+6');
    expect(formatSci(62.31559031)).toBe('62.3156');
    expect(formatSci(0.001)).toBe('0.001');
    expect(formatSci(-12.5)).toBe('-12.5');
  });

  it('parses a number or gives null', () => {
    expect(parseSci(' 1.5e-3 ')).toBe(0.0015);
    expect(parseSci('')).toBeNull();
    expect(parseSci('   ')).toBeNull();
    expect(parseSci('abc')).toBeNull();
    expect(parseSci('Infinity')).toBeNull();
  });

  it('gives what the core input gives', () => {
    for (const v of [null, 0, 1e-7, 0.000999, 0.001, 1, 62.31559031, 999999, 1e6, -3.2e9, Number.NaN]) {
      expect(formatSci(v)).toBe(core.formatSci(v));
    }
    for (const t of ['', '1', ' 2e5', 'x', '-0.5']) expect(parseSci(t)).toBe(core.parseSci(t));
  });
});
