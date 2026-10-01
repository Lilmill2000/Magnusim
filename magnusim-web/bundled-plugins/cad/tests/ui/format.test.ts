// Kit formatters: the core's formatSci, display units, and how typed values are stored.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { exprToStore, formatField, formatQuantity, formatSci, formatVolume, parseLiteral, toDisplay, unitText, commaProblem, fullPrecision, literalDigits } from '../../src/ui/kit/format';

const MM = { length: 'mm', angle: 'deg' } as const;
const IN = { length: 'in', angle: 'rad' } as const;

describe('formatSci (core SciNumberInput parity)', () => {
  it('formats like the core', () => {
    expect(formatSci(0)).toBe('0');
    expect(formatSci(null)).toBe('');
    expect(formatSci(Number.NaN)).toBe('');
    expect(formatSci(20)).toBe('20');
    expect(formatSci(62.31559031)).toBe('62.3156');
    expect(formatSci(0.001)).toBe('0.001');
    expect(formatSci(0.00015290)).toBe('1.5290e-4');
    expect(formatSci(-0.0005)).toBe('-5.0000e-4');
    expect(formatSci(999999)).toBe('999999');
    expect(formatSci(1234567)).toBe('1.2346e+6');
  });
});

describe('display units', () => {
  it('converts internal mm and degrees to the display unit', () => {
    expect(toDisplay(25.4, 'length', IN)).toBeCloseTo(1, 12);
    expect(toDisplay(10, 'length', { length: 'cm', angle: 'deg' })).toBe(1);
    expect(toDisplay(180, 'angle', IN)).toBeCloseTo(Math.PI, 12);
    expect(toDisplay(3, 'scalar', IN)).toBe(3);
    expect(unitText('length', MM)).toBe('mm');
    expect(unitText('angle', MM)).toBe('°');
    expect(unitText('angle', IN)).toBe('rad');
    expect(unitText('scalar', MM)).toBe('');
    expect(formatQuantity(20, 'length', MM)).toBe('20 mm');
    expect(formatQuantity(50.8, 'length', IN)).toBe('2 in');
    expect(formatQuantity(15, 'angle', MM)).toBe('15°');
    expect(formatQuantity(4, 'scalar', MM)).toBe('4');
  });

  it('formats volumes in the length unit cubed', () => {
    expect(formatVolume(6000, MM)).toBe('6000 mm³');
    expect(formatVolume(6000, { length: 'cm', angle: 'deg' })).toBe('6 cm³');
    expect(formatVolume(16387.064, IN)).toBe('1 in³');
    // Readouts group digits from 10,000 up, and a metric part of a cubic metre or more reads in m³ (review round 1).
    expect(formatVolume(1e6, MM)).toBe('1,000,000 mm³');
    expect(formatVolume(4e8, MM)).toBe('400,000,000 mm³');
    expect(formatVolume(26000, MM)).toBe('26,000 mm³');
    expect(formatVolume(6994.6909, MM)).toBe('6994.69 mm³');
    expect(formatVolume(2.5e9, MM)).toBe('2.5 m³');
    expect(formatVolume(999999999.9999, MM)).toBe('1 m³');
    expect(formatVolume(1e18, MM)).toBe('1,000,000,000 m³');
    expect(formatVolume(1e-6, MM)).toBe('1.0000e-6 mm³');
  });
});

describe('typed values', () => {
  it('recognises plain numbers with units of the quantity', () => {
    expect(parseLiteral('20', 'length')).toEqual({ n: 20, unit: '' });
    expect(parseLiteral(' 20 MM ', 'length')).toEqual({ n: 20, unit: 'mm' });
    expect(parseLiteral('1.5e-3in', 'length')).toEqual({ n: 0.0015, unit: 'in' });
    expect(parseLiteral('-.5 ft', 'length')).toEqual({ n: -0.5, unit: 'ft' });
    expect(parseLiteral('15°', 'angle')).toEqual({ n: 15, unit: '°' });
    expect(parseLiteral('15 deg', 'length')).toBeNull();
    expect(parseLiteral('20 mm', 'angle')).toBeNull();
    expect(parseLiteral('width / 2', 'length')).toBeNull();
    expect(parseLiteral('2 * 3', 'length')).toBeNull();
  });

  it('stores a bare number with the display unit and keeps the typed digits', () => {
    expect(exprToStore('20', 'length', MM)).toBe('20 mm');
    expect(exprToStore(' 2 ', 'length', IN)).toBe('2 in');
    expect(exprToStore('20.1234567', 'length', MM)).toBe('20.1234567 mm');
    expect(exprToStore('1.5e-3', 'length', MM)).toBe('1.5e-3 mm');
    expect(exprToStore('15', 'angle', MM)).toBe('15 deg');
    expect(exprToStore('0.5', 'angle', IN)).toBe('0.5 rad');
    expect(exprToStore('3', 'scalar', MM)).toBe('3');
  });

  it('stores anything else as typed', () => {
    expect(exprToStore('1 in', 'length', MM)).toBe('1 in');
    expect(exprToStore('  width / 2 + 3 mm ', 'length', MM)).toBe('width / 2 + 3 mm');
    expect(exprToStore('30°', 'angle', MM)).toBe('30°');
  });
});

describe('fields read like the readouts (review round 2)', () => {
  it('formats a field value as a readout: digit groups from 10,000, tiny values in the core style', () => {
    expect(formatField(20)).toBe('20');
    expect(formatField(1e6)).toBe('1,000,000');
    expect(formatField(12345.678)).toBe('12,345.7');
    expect(formatField(-2500000)).toBe('-2,500,000');
    expect(formatField(0.0001529)).toBe('1.5290e-4');
    expect(formatQuantity(1e6, 'length', MM)).toBe('1,000,000 mm');
  });

  it('refuses commas in numbers, as the core number fields do; a comma between function arguments is fine (review round 3)', () => {
    const why = 'No commas in numbers: write 1500, or 1.5 for a decimal';
    expect(commaProblem('1,500')).toBe(why);
    expect(commaProblem('1,5')).toBe(why);
    expect(commaProblem('1,000,000')).toBe(why);
    expect(commaProblem(' -12,345.5 mm ')).toBe(why);
    expect(commaProblem('width + 1,5')).toBe(why);
    expect(commaProblem('max(1, 2)')).toBeNull();
    expect(commaProblem('min(width, 10 mm) / 2')).toBeNull();
    expect(commaProblem('1500')).toBeNull();
    expect(commaProblem('1.5 mm')).toBeNull();
  });

  it('keeps every digit for editing: the digits as written, or 15 significant digits after a unit change', () => {
    expect(literalDigits('12.3456789 mm')).toBe('12.3456789');
    expect(literalDigits('1e6 mm')).toBe('1e6');
    expect(literalDigits('width')).toBeNull();
    expect(fullPrecision(25.4 / 3)).toBe('8.46666666666667');
    expect(fullPrecision(0.1 + 0.2)).toBe('0.3');
    expect(fullPrecision(1234567.891)).toBe('1234567.891');
  });
});
