// Hole's fastener tables (features/hole/sizes.ts): the metric tap drills are ISO 2306's (M8 6.8 mm,
// M12 10.2 mm: no 6.75 or 10.25 mm drill is sold), the DIN 974-1 counterbores for ISO 4762 socket
// head cap screws (M30: 50 mm across, 31 mm deep), and the words for a size the tables do not have;
// what a size gives (M6: 6.6 mm normal clearance, a 5 mm tap; 1/4-20: #7, 0.201 in; the M6
// counterbore 11 x 6.4 mm and the M5 countersink 11.2 mm), and the sizes refused (M8x1, 1/4-21).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { counterboreFor, countersinkFor, fastener, METRIC_SIZES } from '../../../src/features/hole/sizes';

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

  it('gives the ISO 273 clearance holes and the coarse thread a metric size names; a fine pitch is no size it knows', () => {
    const m6 = fastener('M6')!;
    expect(m6).toMatchObject({ system: 'metric', size: 'M6', thread: 'M6x1', major: 6, pitch: 1, tap: { expr: '5 mm', mm: 5, words: '5 mm' } });
    expect(m6.clearance).toEqual({ close: { expr: '6.4 mm', mm: 6.4 }, normal: { expr: '6.6 mm', mm: 6.6 }, loose: { expr: '7 mm', mm: 7 } });
    // Its coarse pitch named, in any case, with spaces: the same size.
    for (const t of ['M6x1', 'm6', ' M6 x 1 ']) expect(fastener(t), t).toEqual(m6);
    expect(fastener('M5')!.clearance!.loose).toEqual({ expr: '5.8 mm', mm: 5.8 });
    // M8x1 is a fine pitch: refused rather than sized as the coarse M8x1.25. M7 is no ISO 261 size.
    for (const t of ['M8x1', 'M6x0.75', 'M7', 'M', '6']) expect(fastener(t), t).toBeNull();
  });

  it('gives a Unified inch size by its threads per inch or series, in inches: tap drills by drill name, ASME B18.2.8 clearance holes', () => {
    const q = fastener('1/4-20')!;
    expect(q).toMatchObject({ system: 'unified', size: '1/4', thread: '1/4-20 UNC', major: 6.35, pitch: 1.27, tap: { expr: '0.201 in', mm: 5.1054, words: '#7, 0.201 in' } });
    expect(q.clearance!.normal).toEqual({ expr: '0.281 in', mm: 7.1374 });
    // The size alone is its UNC; its UNF by 28 threads per inch or by name.
    expect(fastener('1/4')).toEqual(q);
    expect(fastener('1/4-28')).toMatchObject({ thread: '1/4-28 UNF', tap: { words: '#3, 0.213 in' } });
    expect(fastener('1/4-28 UNF')).toEqual(fastener('1/4-28'));
    expect(fastener('#10-32')).toMatchObject({ size: '#10', thread: '#10-32 UNF', tap: { expr: '0.159 in', words: '#21, 0.159 in' } });
    // #0 has no UNC: alone it is its UNF. #12 has threads but no B18.2.8 clearance hole.
    expect(fastener('#0')).toMatchObject({ thread: '#0-80 UNF' });
    expect(fastener('#12-24')).toMatchObject({ thread: '#12-24 UNC', clearance: null });
    // Threads per inch the size does not have, a series that does not match them, a size not in the table: none.
    for (const t of ['1/4-21', '1/4-20 UNF', '#0-72', '#0 UNC', '11/16', '#7']) expect(fastener(t), t).toBeNull();
  });

  it("gives a clearance size's screw heads: the ISO 4762 counterbore and the ISO 10642 countersink at 90 deg; none for a size off the tables or an inch size", () => {
    expect(counterboreFor('M6')).toEqual({ diameter: 11, depth: 6.4 });
    expect(counterboreFor('M4x0.7')).toEqual({ diameter: 8, depth: 4.4 });
    expect(countersinkFor('M5')).toEqual({ diameter: 11.2 });
    expect(countersinkFor('M6')).toEqual({ diameter: 13.44 });
    expect(countersinkFor('M20')).toEqual({ diameter: 40.32 });
    for (const t of ['M2', 'M2.5', '1/4', '#10']) {
      expect(counterboreFor(t), t).toBeNull();
      expect(countersinkFor(t), t).toBeNull();
    }
    expect(countersinkFor('M24')).toBeNull();
  });
});
