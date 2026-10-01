// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../../src/doc/schema';
import { createUnitsService, formatSci } from '../../src/doc/units';
import type { DocUnits } from '../../src/types/units';

describe('units (scaffold subset)', () => {
  it('new documents follow the app unit system', () => {
    expect(emptyDoc('metric').units).toEqual({ length: 'mm', angle: 'deg' });
    expect(emptyDoc('imperial').units).toEqual({ length: 'in', angle: 'deg' });
  });

  it('evaluates numbers with and without units into mm / deg', () => {
    let u: DocUnits = { length: 'mm', angle: 'deg' };
    const s = createUnitsService(() => u);
    expect(s.evaluate('20', 'length')).toMatchObject({ ok: true, value: 20 });
    expect(s.evaluate('2 in', 'length')).toMatchObject({ ok: true, value: 50.8 });
    expect(s.evaluate('15°', 'angle')).toMatchObject({ ok: true, value: 15 });
    expect(s.evaluate('3 parsecs', 'length')).toMatchObject({ ok: false });
    u = { length: 'in', angle: 'deg' };
    expect(s.evaluate('1', 'length')).toMatchObject({ ok: true, value: 25.4 });
    expect(s.format(50.8, 'length')).toBe('2 in');
    expect(s.format(90, 'angle')).toBe('90°');
  });

  it('formats like the core SciNumberInput', () => {
    expect(formatSci(0.0001234)).toBe('1.2340e-4');
    expect(formatSci(12.3456789)).toBe('12.3457');
    expect(formatSci(2_000_000)).toBe('2.0000e+6');
  });
});
