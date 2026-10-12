// The TypeScript NACA generator reproduces the Airfoil plugin's Python one
// (tests/fixtures/naca.json, written by tests/fixtures/gen_naca.py).
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate, NacaError, parseCode } from '../src/geometry/naca';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/naca.json', import.meta.url), 'utf8')) as {
  sections: { code: string; points: number; closed: boolean; x: number[]; y: number[]; name: string }[];
  errors: { text: string; error: string | null }[];
};

describe('NACA sections', () => {
  for (const c of fixture.sections) {
    it(`NACA ${c.code} (${c.points} per side${c.closed ? ', closed trailing edge' : ''}) matches the Python`, () => {
      const s = generate(c.code, c.points, c.closed);
      expect(s.name).toBe(c.name);
      expect(s.x).toHaveLength(c.x.length);
      for (let i = 0; i < c.x.length; i++) {
        expect(Math.abs(s.x[i] - c.x[i])).toBeLessThan(1e-9);
        expect(Math.abs(s.y[i] - c.y[i])).toBeLessThan(1e-9);
      }
    });
  }
  it('refuses the designations the Python refuses, with the same reasons', () => {
    for (const e of fixture.errors) {
      if (e.error === null) expect(() => parseCode(e.text)).not.toThrow();
      else expect(() => parseCode(e.text)).toThrow(new NacaError(e.error));
    }
  });
  it('accepts "NACA 2412" and "naca0012" spellings', () => {
    expect(parseCode('NACA 2412')).toBe('2412');
    expect(parseCode(' naca0012 ')).toBe('0012');
  });
});
