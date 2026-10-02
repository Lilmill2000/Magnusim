import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatElapsed, formatEta, formatSimTime } from './time';
import { formatSimTime as residualFormatSimTime } from '../../panels/run/ResidualPlot';
import { formatElapsed as jobsFormatElapsed } from '../../store/jobs';

// The viewport chip's own formatEta (and the formatElapsed it calls), read from runtime.js.
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workbench', 'runtime.js'), 'utf8');
function runtimeSource(name: string): string {
  const m = runtime.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!m) throw new Error(`runtime.js has no function ${name}`);
  return m[0];
}
const coreFormatEta = new Function(`${runtimeSource('formatElapsed')}\n${runtimeSource('formatEta')}\nreturn formatEta;`)() as (
  ms: unknown,
) => string | null;

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
];

describe('formatSimTime', () => {
  it('labels simulated seconds', () => {
    for (const [v, label] of SIM_TIMES) expect(formatSimTime(v), String(v)).toBe(label);
    expect(formatSimTime(Number.NaN)).toBe('—');
    expect(formatSimTime('abc')).toBe('—');
    expect(formatSimTime('0.5')).toBe('0.5 s');
  });

  it('drops the unit with noUnit', () => {
    expect(formatSimTime(0.005, { noUnit: true })).toBe('0.005');
    expect(formatSimTime(0, { noUnit: true })).toBe('0');
  });

  it('equals the residual plot label for every number in the table', () => {
    for (const [v] of SIM_TIMES) expect(formatSimTime(v)).toBe(residualFormatSimTime(v));
    expect(formatSimTime(Number.NaN)).toBe(residualFormatSimTime(Number.NaN));
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

  it('equals the Mesh and Run panels below one hour', () => {
    for (const ms of [0, 999, 1000, 59_000, 61_500, 600_000, 3_599_999]) expect(formatElapsed(ms)).toBe(jobsFormatElapsed(ms));
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

  it("equals runtime.js's formatEta", () => {
    const inputs: unknown[] = [null, undefined, -1, Number.NaN, 'x', 0, 1, 999, 7999, 8000, 8001, 9999, 10_000, 59_999, 60_000, 70_000, 3_599_999, 3_600_000, 3_725_000, '9000'];
    for (const ms of inputs) expect(formatEta(ms), String(ms)).toBe(coreFormatEta(ms));
  });
});
