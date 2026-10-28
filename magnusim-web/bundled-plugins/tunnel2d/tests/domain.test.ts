// The tunnel's pixels on the GPU canvas (src/render/domain.ts) and the dark view's margins painted
// by them (src/ui/overlay.ts), against the render shader's own test (src/sim/kernels.ts, fs) run
// pixel by pixel in f32 as a GPU runs it, with and without a fused multiply-add: every pixel the
// shader leaves as the light margin is under the dark margin or the ring at the wall, and what is
// painted over the tunnel is only its edge. At device pixel ratios 1, 1.25, 1.5 and 2: zoomed out,
// zoomed in, panned partly and wholly off the canvas, walls on pixel centres and within a few
// roundings of one.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { domainRectPx, type Drawn } from '../src/render/domain';
import { defaultScene } from '../src/scene/scene';
import { paintOverlay, type OverlayColours, type OverlayState } from '../src/ui/overlay';
import { recordingContext } from './canvasLog';

const f = Math.fround;
const LENGTH = 8;
const NX = 256;
const NY = 128;
const DX = LENGTH / NX;
/** The view's box (CSS px). */
const BOX = { w: 160, h: 100 };
const DPRS = [1, 1.25, 1.5, 2];

/** The frame the engine draws for a view (its centre and metres per CSS px), as it records it. */
function drawnFor(dpr: number, v: { cx: number; cy: number; mpp: number }): Drawn {
  return {
    scale: f(v.mpp / dpr / DX),
    ox: f((v.cx - (BOX.w / 2) * v.mpp) / DX - 0.5),
    oy: f((v.cy + (BOX.h / 2) * v.mpp) / DX - 0.5),
    nx: NX,
    ny: NY,
    w: Math.round(BOX.w * dpr),
    h: Math.round(BOX.h * dpr),
  };
}

/** The shader's test for a column (sign 1) or a row (sign -1): whether its pixel centres' lattice coordinate is off the tunnel. */
function offAt(o: number, s: number, i: number, n: number, sign: 1 | -1, fma: boolean): boolean {
  const p = f(i + 0.5);
  const l = fma ? f(o + sign * p * s) : f(o + sign * f(p * s));
  return l < -0.5 || l > f(f(n) - 0.5);
}

/** What the overlay paints on each pixel (device px), from its log: 'm' the margin, 'w' the wall's ring, '' nothing. */
function paintedBy(log: string[], w: number, h: number): string[] {
  const out = new Array<string>(w * h).fill('');
  const path: number[][] = [];
  let style = '';
  const paint = (rects: number[][], evenOdd: boolean) => {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let n = 0;
        for (const [x, y, rw, rh] of rects) if (i >= x && i < x + rw && j >= y && j < y + rh) n++;
        if (evenOdd ? n % 2 === 1 : n > 0) out[j * w + i] = style;
      }
    }
  };
  for (const line of log) {
    const set = /^fillStyle = "(.*)"$/.exec(line);
    if (set) style = set[1] === '#1b1f27' ? 'm' : 'w';
    const call = /^(\w+)\((.*)\)$/.exec(line);
    if (!call) continue;
    const args = call[2] ? call[2].split(', ').map(Number) : [];
    if (call[1] === 'beginPath') path.length = 0;
    else if (call[1] === 'rect') path.push(args);
    else if (call[1] === 'fillRect') paint([args], false);
    else if (call[1] === 'fill') paint(path, call[2] === '"evenodd"');
  }
  return out;
}

const DARK: OverlayColours = {
  sel: '#2f6fde',
  selInk: '#7aa7ff',
  ghost: '#6b7382',
  halo: '#1b1f27',
  probe: '#e6e9ef',
  markHalo: '#1b1f27',
  rakes: [],
  sketch: { under: '', fully: '', over: '', construction: '', pick: '', halo: '', preview: '' },
  margin: '#1b1f27',
  wall: '#6b7382',
};

/**
 * Paints the dark margins of one frame and checks them in both f32 orders: the problems found, and
 * how many of the rectangle's edges domainRectPx put a pixel off the shader's (a tie).
 */
function check(d: Drawn, dpr: number, label: string): { problems: string[]; ties: number } {
  const log: string[] = [];
  const st: OverlayState = {
    view: { w: d.w / dpr, h: d.h / dpr, dpr },
    scene: { ...defaultScene(), bodies: [], rakes: [], probes: [] },
    selected: null,
    drag: null,
    toScreen: () => ({ x: 0, y: 0 }),
    poseOf: () => ({ x: 0, y: 0, angle: 0 }),
    handleOf: () => ({ x: 0, y: 0, cx: 0, cy: 0 }),
  };
  paintOverlay(recordingContext(log, { width: d.w, height: d.h }), st, DARK, d);
  const painted = paintedBy(log, d.w, d.h);
  const r = domainRectPx(d);
  const t = Math.max(1, Math.round(dpr));
  const problems: string[] = [];
  let ties = 0;
  for (const fma of [false, true]) {
    const at = `${label} (dpr ${dpr}, ${fma ? 'fused' : 'two roundings'})`;
    const colOff = Array.from({ length: d.w }, (_, i) => offAt(d.ox, d.scale, i, d.nx, 1, fma));
    const rowOff = Array.from({ length: d.h }, (_, j) => offAt(d.oy, d.scale, j, d.ny, -1, fma));
    // Within k px of a margin column or row.
    const near = (i: number, j: number, k: number) => {
      for (let q = 1; q <= k; q++) if ((i - q >= 0 && colOff[i - q]) || (i + q < d.w && colOff[i + q]) || (j - q >= 0 && rowOff[j - q]) || (j + q < d.h && rowOff[j + q])) return true;
      return false;
    };
    for (let j = 0; j < d.h; j++) {
      for (let i = 0; i < d.w; i++) {
        const off = colOff[i] || rowOff[j];
        const p = painted[j * d.w + i];
        if (off && p === '') problems.push(`${at}: the shader's margin pixel ${i}, ${j} is left light`);
        // Over the tunnel: a pixel next to the wall (a tie), or the ring's width in from it.
        if (!off && p === 'm' && !near(i, j, 1)) problems.push(`${at}: tunnel pixel ${i}, ${j} painted as margin`);
        if (!off && p === 'w' && !near(i, j, t + 1)) problems.push(`${at}: ring pixel ${i}, ${j} away from the wall`);
      }
    }
    const cols = colOff.map((o) => !o);
    const rows = rowOff.map((o) => !o);
    if (!r) {
      if (cols.includes(true) && rows.includes(true)) problems.push(`${at}: no tunnel on the canvas, but the shader draws one`);
      continue;
    }
    for (const [a, b] of [
      [r.x0, cols.indexOf(true)],
      [r.x1, cols.lastIndexOf(true) + 1],
      [r.y0, rows.indexOf(true)],
      [r.y1, rows.lastIndexOf(true) + 1],
    ]) {
      if (Math.abs(a - b) > 1) problems.push(`${at}: an edge at ${a}, the shader's at ${b}`);
      if (a !== b) ties++;
    }
  }
  return { problems, ties };
}

/** A small, repeatable random sequence (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An f32 value moved by `n` of its units in the last place. */
function ulps(v: number, n: number): number {
  const a = new Float32Array([v]);
  const b = new Int32Array(a.buffer);
  b[0] += v >= 0 ? n : -n;
  return a[0];
}

describe("the tunnel's pixels and the dark margins", () => {
  for (const dpr of DPRS) {
    it(`cover every margin pixel the shader draws, and paint over only the tunnel's edge, at device pixel ratio ${dpr}`, () => {
      const w = Math.round(BOX.w * dpr);
      const h = Math.round(BOX.h * dpr);
      // The panned views put a wall within a rounding of a pixel centre at some ratios (cx 0.5 m at
      // 0.04 m per px: 12.5 px); the views built on exact values have the shader's walls to the pixel.
      const frames: [string, Drawn, boolean][] = [
        ['zoomed out', drawnFor(dpr, { cx: 4, cy: 2, mpp: LENGTH / 120 }), false],
        ['zoomed in (no margin)', drawnFor(dpr, { cx: 4, cy: 2, mpp: 0.01 }), false],
        ['panned partly off (left and top walls on the canvas)', drawnFor(dpr, { cx: 0.5, cy: 3.9, mpp: LENGTH / 200 }), false],
        ['panned partly off (right and bottom walls on the canvas)', drawnFor(dpr, { cx: 7.6, cy: 0.2, mpp: LENGTH / 250 }), false],
        ['panned wholly off', drawnFor(dpr, { cx: -20, cy: 2, mpp: LENGTH / 120 }), false],
        // A cell a device px: the walls exactly on pixel centres (lattice -0.5 at pixel 10, n - 0.5 further on), then between pixels.
        ['walls on pixel centres', { scale: 1, ox: -11, oy: 70, nx: 100, ny: 60, w, h }, true],
        ['walls between pixels', { scale: 1, ox: -10.5, oy: 69.5, nx: 100, ny: 60, w, h }, true],
        ['two px a cell, walls on pixel centres', { scale: 0.5, ox: -5.75, oy: 65.25, nx: 50, ny: 30, w, h }, true],
      ];
      const problems: string[] = [];
      let ties = 0;
      for (const [label, d, exact] of frames) {
        const c = check(d, dpr, label);
        problems.push(...c.problems);
        if (exact) ties += c.ties;
      }
      expect(problems).toEqual([]);
      expect(ties).toBe(0);
    });
  }

  it('and with walls within a few roundings of a pixel centre, either side', () => {
    const next = random(20261028);
    const problems: string[] = [];
    for (let n = 0; n < 48; n++) {
      const dpr = DPRS[n % DPRS.length];
      const w = Math.round(BOX.w * dpr);
      const h = Math.round(BOX.h * dpr);
      // Cells per device px, then the left wall (lattice -0.5) on column k's centre and the top wall
      // (n - 0.5) on row k's, each moved a few f32 steps.
      const s = f(0.15 + 1.5 * next());
      const k = 3 + Math.floor(next() * 20);
      const nx = 20 + Math.floor(next() * 60);
      const ny = 10 + Math.floor(next() * 40);
      const ox = ulps(f(-0.5 - (k + 0.5) * s), Math.round(next() * 6 - 3));
      const oy = ulps(f(ny - 0.5 + (k + 0.5) * s), Math.round(next() * 6 - 3));
      problems.push(...check({ scale: s, ox, oy, nx, ny, w, h }, dpr, `near tie ${n}`).problems);
    }
    expect(problems).toEqual([]);
  });
});
