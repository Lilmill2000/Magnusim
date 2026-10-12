// NACA 4- and 5-digit sections as Selig coordinates: a port of the Airfoil plugin's
// airfoil/naca.py (same constants, same point order, same rounding), checked against
// it by tests/naca.test.ts.
//
// Coordinates run from the upper trailing edge over the upper surface to the leading
// edge and back along the lower surface (Selig order, counter-clockwise), chord 1,
// leading edge at (0, 0), cosine-spaced in x.
// SPDX-License-Identifier: GPL-3.0-or-later

// Standard 5-digit mean lines (Q = 0): P -> [r, k1].
const FIVE_STANDARD: Record<number, [number, number]> = {
  1: [0.058, 361.4],
  2: [0.126, 51.64],
  3: [0.2025, 15.957],
  4: [0.29, 6.643],
  5: [0.391, 3.23],
};
// Reflexed 5-digit mean lines (Q = 1): P -> [r, k1, k2/k1].
const FIVE_REFLEX: Record<number, [number, number, number]> = {
  2: [0.13, 51.99, 0.000764],
  3: [0.217, 15.793, 0.00677],
  4: [0.318, 6.52, 0.0303],
  5: [0.441, 3.191, 0.1355],
};

export const MIN_POINTS_PER_SIDE = 20;
export const MAX_POINTS_PER_SIDE = 250;
export const DEFAULT_POINTS_PER_SIDE = 81;

export class NacaError extends Error {}

export interface NacaSection {
  code: string;
  name: string;
  x: number[];
  y: number[];
}

const CODE = /^\s*(?:naca\s*)?(\d{4,5})\s*$/i;

/** The 4 or 5 digits of a designation such as "2412", "NACA 23012" or "naca0012". */
export function parseCode(text: string): string {
  const m = CODE.exec(String(text ?? ''));
  if (!m) throw new NacaError('Enter a NACA 4-digit or 5-digit designation, such as 2412 or 23012.');
  const code = m[1];
  if (code.length === 4) checkFour(code);
  else checkFive(code);
  return code;
}

const digit = (code: string, i: number) => Number(code[i]);

function checkFour(code: string) {
  const m = digit(code, 0);
  const p = digit(code, 1);
  const t = Number(code.slice(2));
  if (t <= 0) throw new NacaError(`NACA ${code}: the thickness (last two digits) must be above 0.`);
  if ((m === 0) !== (p === 0)) throw new NacaError(`NACA ${code}: camber and its position must both be 0 or both be above 0.`);
}

function checkFive(code: string) {
  const lift = digit(code, 0);
  const pos = digit(code, 1);
  const reflex = digit(code, 2);
  const t = Number(code.slice(3));
  if (t <= 0) throw new NacaError(`NACA ${code}: the thickness (last two digits) must be above 0.`);
  if (lift === 0) throw new NacaError(`NACA ${code}: the first digit (design lift) must be above 0.`);
  if (reflex !== 0 && reflex !== 1) throw new NacaError(`NACA ${code}: the third digit must be 0 (standard) or 1 (reflexed).`);
  const table = reflex ? FIVE_REFLEX : FIVE_STANDARD;
  if (!(pos in table)) {
    const allowed = Object.keys(table).sort().join(', ');
    throw new NacaError(`NACA ${code}: a ${reflex ? 'reflexed' : 'standard'} 5-digit mean line has its second digit in ${allowed}.`);
  }
}

function thickness(x: number, t: number, closedTe: boolean): number {
  const a4 = closedTe ? -0.1036 : -0.1015;
  return 5.0 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 + a4 * x ** 4);
}

function camberFour(code: string, x: number): [number, number] {
  const m = digit(code, 0) / 100.0;
  const p = digit(code, 1) / 10.0;
  if (m === 0) return [0, 0];
  if (x < p) return [(m / p ** 2) * (2 * p * x - x ** 2), ((2 * m) / p ** 2) * (p - x)];
  return [(m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x ** 2), ((2 * m) / (1 - p) ** 2) * (p - x)];
}

function camberFive(code: string, x: number): [number, number] {
  const lift = digit(code, 0);
  const pos = digit(code, 1);
  const reflex = digit(code, 2);
  const scale = (3.0 * lift) / 20.0 / 0.3;
  if (!reflex) {
    const [r, k1] = FIVE_STANDARD[pos];
    if (x < r) {
      return [scale * ((k1 / 6.0) * (x ** 3 - 3 * r * x ** 2 + r ** 2 * (3 - r) * x)), scale * ((k1 / 6.0) * (3 * x ** 2 - 6 * r * x + r ** 2 * (3 - r)))];
    }
    return [scale * (((k1 * r ** 3) / 6.0) * (1 - x)), scale * ((-k1 * r ** 3) / 6.0)];
  }
  const [r, k1, k21] = FIVE_REFLEX[pos];
  const tail = k21 * (1 - r) ** 3;
  if (x < r) {
    return [scale * ((k1 / 6.0) * ((x - r) ** 3 - tail * x - r ** 3 * x + r ** 3)), scale * ((k1 / 6.0) * (3 * (x - r) ** 2 - tail - r ** 3))];
  }
  return [scale * ((k1 / 6.0) * (k21 * (x - r) ** 3 - tail * x - r ** 3 * x + r ** 3)), scale * ((k1 / 6.0) * (3 * k21 * (x - r) ** 2 - tail - r ** 3))];
}

/** Round to 1e-10, as the Python does, so -0 and float noise never reach a test. */
function clean(v: number): number {
  const out = Math.round(v * 1e10) / 1e10;
  return out === 0 ? 0 : out;
}

/** The section's Selig coordinates (2 * pointsPerSide - 1 points). */
export function generate(codeText: string, pointsPerSide = DEFAULT_POINTS_PER_SIDE, closedTe = false): NacaSection {
  const code = parseCode(codeText);
  const n = Math.trunc(pointsPerSide);
  if (!(n >= MIN_POINTS_PER_SIDE && n <= MAX_POINTS_PER_SIDE)) {
    throw new NacaError(`Points per side must be from ${MIN_POINTS_PER_SIDE} to ${MAX_POINTS_PER_SIDE}.`);
  }
  const t = Number(code.slice(-2)) / 100.0;
  const camber = code.length === 4 ? camberFour : camberFive;
  const upper: [number, number][] = [];
  const lower: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const beta = (Math.PI * i) / (n - 1);
    const x = 0.5 * (1.0 - Math.cos(beta));
    const yt = thickness(x, t, closedTe);
    const [yc, dyc] = camber(code, x);
    const theta = Math.atan(dyc);
    upper.push([x - yt * Math.sin(theta), yc + yt * Math.cos(theta)]);
    lower.push([x + yt * Math.sin(theta), yc - yt * Math.cos(theta)]);
  }
  const pts = [...upper.reverse(), ...lower.slice(1)];
  return { code, name: `NACA ${code}`, x: pts.map((p) => clean(p[0])), y: pts.map((p) => clean(p[1])) };
}
