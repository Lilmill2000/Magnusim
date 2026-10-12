// Airfoil coordinate files (.dat), Selig or Lednicer, read the way the Airfoil plugin's
// airfoil/datfile.py reads them: always Selig order back, chord 1, leading edge at
// (0, 0), with a list of what was changed (`warnings`). A file that cannot be used
// throws DatError with a message that names the line.
// SPDX-License-Identifier: GPL-3.0-or-later
import { selfIntersects, signedArea } from './polygon';

export const MAX_BYTES = 256 * 1024;
const MAX_NAME = 80;
export const MIN_POINTS = 10;
export const MAX_POINTS = 1000;

export class DatError extends Error {}

export interface DatSection {
  name: string;
  x: number[];
  y: number[];
  layout: 'selig' | 'lednicer';
  warnings: string[];
}

function numbers(text: string): number[] | null {
  const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const v = Number(p.replace(/[Dd]/, 'e'));
    if (p === '' || Number.isNaN(v)) return null;
    out.push(v);
  }
  return out;
}

function plainName(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
}

const flat = (x: number[], y: number[]) => x.flatMap((v, i) => [v, y[i]]);

export function parseDat(text: string, filename = ''): DatSection {
  if (new TextEncoder().encode(text).length > MAX_BYTES) {
    throw new DatError(`The file is larger than ${MAX_BYTES / 1024} KB; an airfoil file is a few KB.`);
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let name = '';
  const rows: [number, number, number][] = [];
  let started = false;
  lines.forEach((raw, idx) => {
    const no = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const nums = numbers(line);
    if (!started && !name && (nums === null || nums.length !== 2)) {
      name = plainName(line);
      return;
    }
    if (nums === null) throw new DatError(`Line ${no}: expected two numbers (x and y), found “${plainName(line).slice(0, 40)}”.`);
    if (nums.length !== 2) throw new DatError(`Line ${no}: expected two numbers (x and y), found ${nums.length}.`);
    if (!nums.every(Number.isFinite)) throw new DatError(`Line ${no}: the numbers must be finite.`);
    rows.push([no, nums[0], nums[1]]);
    started = true;
  });
  if (!name) {
    const stem = String(filename || '').replace(/\\/g, '/').split('/').pop()?.replace(/\.[A-Za-z0-9]{1,4}$/, '') ?? '';
    name = plainName(stem) || 'Imported airfoil';
  }
  if (!rows.length) throw new DatError('The file has no coordinates.');
  const warnings: string[] = [];
  const first = rows[0];
  let x: number[];
  let y: number[];
  let layout: DatSection['layout'];
  if (first[1] >= 2 && first[2] >= 2 && Number.isInteger(first[1]) && Number.isInteger(first[2])) {
    [x, y] = fromLednicer(rows, first[1], first[2]);
    layout = 'lednicer';
    warnings.push('Read as a Lednicer file (upper and lower surfaces apart) and joined in Selig order.');
  } else {
    x = rows.map((r) => r[1]);
    y = rows.map((r) => r[2]);
    layout = 'selig';
  }
  [x, y] = check(x, y, warnings);
  return { name, x, y, layout, warnings };
}

function fromLednicer(rows: [number, number, number][], nUpper: number, nLower: number): [number[], number[]] {
  const pts = rows.slice(1);
  if (pts.length !== nUpper + nLower) {
    throw new DatError(`Line ${rows[0][0]}: the file says ${nUpper} upper and ${nLower} lower points, but it has ${pts.length} points.`);
  }
  const upper = pts.slice(0, nUpper);
  const lower = pts.slice(nUpper);
  const ux = upper.map((p) => p[1]).reverse();
  const uy = upper.map((p) => p[2]).reverse();
  let lx = lower.map((p) => p[1]);
  let ly = lower.map((p) => p[2]);
  if (lower.length && upper.length && Math.abs(lower[0][1] - upper[0][1]) <= 1e-9 && Math.abs(lower[0][2] - upper[0][2]) <= 1e-9) {
    lx = lx.slice(1);
    ly = ly.slice(1);
  }
  return [[...ux, ...lx], [...uy, ...ly]];
}

function check(x0: number[], y0: number[], warnings: string[]): [number[], number[]] {
  let x = [x0[0]];
  let y = [y0[0]];
  let dropped = 0;
  for (let i = 1; i < x0.length; i++) {
    if (Math.abs(x0[i] - x[x.length - 1]) <= 1e-12 && Math.abs(y0[i] - y[y.length - 1]) <= 1e-12) {
      dropped++;
      continue;
    }
    x.push(x0[i]);
    y.push(y0[i]);
  }
  if (dropped) warnings.push(`Removed ${dropped} repeated point${dropped !== 1 ? 's' : ''}.`);
  if (x.length < MIN_POINTS) throw new DatError(`The file has ${x.length} points; an airfoil needs at least ${MIN_POINTS}.`);
  if (x.length > MAX_POINTS) throw new DatError(`The file has ${x.length} points; at most ${MAX_POINTS} are read.`);
  const xmin = Math.min(...x);
  const xmax = Math.max(...x);
  const chord = xmax - xmin;
  if (chord <= 0) throw new DatError('Every point has the same x: this is not an airfoil.');
  const le = x.indexOf(xmin);
  if (le === 0 || le === x.length - 1) {
    throw new DatError('The points must start at the trailing edge, run over one surface to the leading edge and back along the other (Selig order).');
  }
  if (Math.min(x[0], x[x.length - 1]) < xmin + 0.5 * chord) throw new DatError('The first and last points must be at the trailing edge (Selig order).');
  const lex = x[le];
  const ley = y[le];
  const atOrigin = Math.min(...x.map((a, i) => Math.hypot(a, y[i]))) <= 2e-3;
  if (Math.abs(chord - 1) > 1e-3 || !atOrigin) {
    x = x.map((v) => (v - lex) / chord);
    y = y.map((v) => (v - ley) / chord);
    warnings.push(Math.abs(chord - 1) > 1e-3 ? `Scaled to chord 1 (it was ${Number(chord.toPrecision(6))}).` : 'Moved so that the leading edge is at (0, 0).');
  }
  if (signedArea(flat(x, y)) < 0) {
    x = x.reverse();
    y = y.reverse();
    warnings.push('The points ran over the lower surface first; reversed to Selig order (upper surface first).');
  }
  if (selfIntersects(flat(x, y))) throw new DatError('The outline crosses itself.');
  // Thickness: the largest vertical gap between the surfaces, sampled along the chord.
  if (maxThickness(x, y) < 0.002) throw new DatError('The section is thinner than 0.2 % of its chord.');
  return [x, y];
}

function maxThickness(x: number[], y: number[]): number {
  const p = flat(x, y);
  let best = 0;
  for (let s = 1; s < 50; s++) {
    const xs = s / 50;
    const ys: number[] = [];
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ax, ay, bx, by] = [p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]];
      if (ax > xs !== bx > xs) ys.push(ay + ((xs - ax) * (by - ay)) / (bx - ax));
    }
    if (ys.length >= 2) best = Math.max(best, Math.max(...ys) - Math.min(...ys));
  }
  return best;
}
