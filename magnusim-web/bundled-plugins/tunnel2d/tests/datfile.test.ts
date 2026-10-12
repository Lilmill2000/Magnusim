// .dat import: Selig and Lednicer files, the fixes it reports, and the files it refuses.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DatError, parseDat } from '../src/geometry/datfile';
import { generate } from '../src/geometry/naca';
import { signedArea } from '../src/geometry/polygon';

const naca = generate('2412', 40);
const selig = (name: string, x: number[], y: number[]) => [name, ...x.map((v, i) => `${v.toFixed(6)} ${y[i].toFixed(6)}`)].join('\n');

describe('.dat files', () => {
  it('reads a Selig file as it is', () => {
    const s = parseDat(selig('NACA 2412 test', naca.x, naca.y));
    expect(s.name).toBe('NACA 2412 test');
    expect(s.layout).toBe('selig');
    expect(s.x).toHaveLength(naca.x.length);
    expect(s.warnings).toEqual([]);
    expect(signedArea(s.x.flatMap((v, i) => [v, s.y[i]]))).toBeGreaterThan(0);
  });
  it('reads a Lednicer file into Selig order', () => {
    const n = (naca.x.length + 1) / 2;
    const upper = naca.x.slice(0, n).map((x, i) => [x, naca.y[i]]).reverse();
    const lower = naca.x.slice(n - 1).map((x, i) => [x, naca.y[n - 1 + i]]);
    const text = ['LED', `${upper.length}. ${lower.length}.`, '', ...upper.map((p) => p.join(' ')), '', ...lower.map((p) => p.join(' '))].join('\n');
    const s = parseDat(text);
    expect(s.layout).toBe('lednicer');
    expect(s.x).toHaveLength(naca.x.length);
    expect(s.warnings[0]).toContain('Lednicer');
  });
  it('scales to chord 1 and reverses a lower-surface-first file, and says so', () => {
    const x = [...naca.x].reverse().map((v) => v * 2);
    const y = [...naca.y].reverse().map((v) => v * 2);
    const s = parseDat(selig('big', x, y));
    expect(Math.max(...s.x)).toBeCloseTo(1, 6);
    expect(s.warnings.join(' ')).toContain('Scaled to chord 1');
    expect(s.warnings.join(' ')).toContain('reversed to Selig order');
  });
  it('names a nameless file after the file', () => {
    const s = parseDat(naca.x.map((v, i) => `${v} ${naca.y[i]}`).join('\n'), 'C:\\foils\\my-foil.dat');
    expect(s.name).toBe('my-foil');
  });
  it('refuses what it cannot use, naming the line', () => {
    expect(() => parseDat('name\n1 0\n0.5 x\n')).toThrow(/Line 3/);
    expect(() => parseDat('name\n1 0 0\n')).toThrow(/Line 2: expected two numbers/);
    expect(() => parseDat('name\n')).toThrow(new DatError('The file has no coordinates.'));
    expect(() => parseDat(selig('few', naca.x.slice(0, 5), naca.y.slice(0, 5)))).toThrow(/at least 10/);
    const flat = naca.x.map(() => 0);
    expect(() => parseDat(selig('flat', naca.x, flat))).toThrow(/thinner than 0.2 %/);
  });
});
