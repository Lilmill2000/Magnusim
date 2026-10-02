import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatElapsed, formatEta, formatSimTime } from './time';
import { formatElapsed as jobsFormatElapsed } from '../../store/jobs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
// Every place that labels times, which must use these and keep no copy of its own.
const USERS = [
  'workbench/runtime.js',
  'panels/run/ResidualPlot.tsx',
  'home/controller.ts',
  'store/jobs.ts',
  '../bundled-plugins/incompressible_flow/ui/transient.ts',
];

const SIM_TIMES: Array<[number, string]> = [
  [0, '0 s'],
  [5, '5 s'],
  [0.1, '0.1 s'],
  [2.5e-4, '2.5e-4 s'],
  [12.345, '12.3 s'],
  [0.005, '0.005 s'],
  [0.0012, '0.0012 s'],
  [150, '150 s'],
  [-0.25, '-0.25 s'],
  // Rounding that carries into the next band is labelled in that band.
  [99.95, '100 s'],
  [9.9996e-4, '0.001 s'],
  [0.0099996, '0.01 s'],
  [-99.95, '-100 s'],
];

describe('formatSimTime', () => {
  it('labels simulated seconds', () => {
    for (const [v, label] of SIM_TIMES) expect(formatSimTime(v), String(v)).toBe(label);
    expect(formatSimTime(Number.NaN)).toBe('—');
    expect(formatSimTime('abc')).toBe('—');
    expect(formatSimTime('0.5')).toBe('0.5 s');
  });

  it('is — for no value, not 0 s', () => {
    for (const v of [null, undefined, '', '  ']) expect(formatSimTime(v), JSON.stringify(v)).toBe('—');
    expect(formatSimTime(null, { noUnit: true })).toBe('—');
  });

  it('drops the unit with noUnit', () => {
    expect(formatSimTime(0.005, { noUnit: true })).toBe('0.005');
    expect(formatSimTime(0, { noUnit: true })).toBe('0');
  });

  it('is the one copy: the workbench, residual plot, Home and Incompressible Flow import it', () => {
    for (const rel of USERS) {
      const src = read(rel);
      expect(src, rel).toMatch(/import \{[^}]*\bformat(SimTime|Elapsed)\b[^}]*\} from '([./]*plugin-ui\/format\/time|@magnusim\/plugin-ui)'/);
      expect(src, rel).not.toMatch(/function (formatSimTime|formatHomeSimTime|formatElapsed|formatHomeClock|formatEta)\b/);
    }
  });
});

describe('formatElapsed', () => {
  it('is m:ss below an hour and h:mm:ss from one hour', () => {
    expect(formatElapsed(59_000)).toBe('0:59');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(3_600_000)).toBe('1:00:00');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('is 0:00 for a value that is not a number', () => {
    expect(formatElapsed(Number.NaN)).toBe('0:00');
    expect(formatElapsed(undefined)).toBe('0:00');
    expect(formatElapsed('x')).toBe('0:00');
  });

  it('is the Mesh panel clock, also past an hour', () => {
    expect(jobsFormatElapsed).toBe(formatElapsed);
    expect(jobsFormatElapsed(3_725_000)).toBe('1:02:05');
  });
});

describe('formatEta', () => {
  it('says what is left, or null when unknown', () => {
    expect(formatEta(7000)).toBe('< 10s left');
    expect(formatEta(70_000)).toBe('~1:10 left');
    expect(formatEta(3_725_000)).toBe('~1:02:05 left');
    expect(formatEta(null)).toBeNull();
    expect(formatEta(undefined)).toBeNull();
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(Number.NaN)).toBeNull();
  });

  it('says "< 10s left" below 8 s, as the viewport chip does', () => {
    expect(formatEta(0)).toBe('< 10s left');
    expect(formatEta(7999)).toBe('< 10s left');
    expect(formatEta(8000)).toBe('~0:08 left');
    expect(formatEta(9999)).toBe('~0:09 left');
  });

});
