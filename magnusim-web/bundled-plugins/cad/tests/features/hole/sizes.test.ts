// Hole's fastener tables (features/hole/sizes.ts): the metric tap drills are ISO 2306's (M8 6.8 mm,
// M12 10.2 mm: no 6.75 or 10.25 mm drill is sold), the DIN 974-1 counterbores for ISO 4762 socket
// head cap screws (M30: 50 mm across, 31 mm deep), and the words for a size the tables do not have.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { counterboreFor, fastener, METRIC_SIZES } from '../../../src/features/hole/sizes';

describe('hole sizes', () => {
  it("taps each metric size with ISO 2306's drill", () => {
    const taps = Object.fromEntries(['M1.6', 'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24', 'M30', 'M36', 'M42', 'M48', 'M56', 'M60', 'M64'].map((m) => [m, fastener(m)!.tap.mm]));
    expect(taps).toEqual({ 'M1.6': 1.25, M2: 1.6, 'M2.5': 2.05, M3: 2.5, M4: 3.3, M5: 4.2, M6: 5, M8: 6.8, M10: 8.5, M12: 10.2, M14: 12, M16: 14, M20: 17.5, M24: 21, M30: 26.5, M36: 32, M42: 37.5, M48: 43, M56: 50.5, M60: 54.5, M64: 58 });
    expect(fastener('M8')!.tap).toEqual({ expr: '6.8 mm', mm: 6.8, words: '6.8 mm' });
    expect(fastener('M12x1.75')!.tap.expr).toBe('10.2 mm');
  });

  it('counterbores each ISO 4762 socket head as DIN 974-1 gives it', () => {
    const rows = Object.fromEntries(['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24', 'M30'].map((m) => [m, counterboreFor(m)]));
    expect(rows).toEqual({
      M3: { diameter: 6.5, depth: 3.4 },
      M4: { diameter: 8, depth: 4.4 },
      M5: { diameter: 10, depth: 5.4 },
      M6: { diameter: 11, depth: 6.4 },
      M8: { diameter: 15, depth: 8.6 },
      M10: { diameter: 18, depth: 10.6 },
      M12: { diameter: 20, depth: 12.6 },
      M14: { diameter: 24, depth: 14.6 },
      M16: { diameter: 26, depth: 16.6 },
      M20: { diameter: 33, depth: 20.6 },
      M24: { diameter: 40, depth: 24.8 },
      M30: { diameter: 50, depth: 31 },
    });
    expect(counterboreFor('M36')).toBeNull();
  });

  it('lists the metric sizes it has, so a refusal of M18 or M27 names them', () => {
    expect(METRIC_SIZES).toBe('M1.6, M2, M2.5, M3, M4, M5, M6, M8, M10, M12, M14, M16, M20, M24, M30, M36, M42, M48, M56, M60, M64');
    for (const m of ['M18', 'M22', 'M27', 'M33', 'M3.5']) expect(fastener(m), m).toBeNull();
  });
});
