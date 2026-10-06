import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { plotGeometry, type ResidualSeries } from '../../panels/run/ResidualPlot';
import {
  graphTick,
  legendSeries,
  linePlotGeometry,
  nearestRow,
  niceTicks,
  PAD_B,
  PAD_T,
  seriesColor,
  tipLeft,
  xTickLabel,
  PAD_L,
  PAD_R,
  PLOT_W,
  type LineRow,
  type LineSeries,
} from './linePlotGeometry';

// The core's own copies, read from runtime.js (the monitor graphs' linear axis).
const runtime = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workbench', 'runtime.js'), 'utf8');
function runtimeFn<T>(name: string): T {
  const m = runtime.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
  if (!m) throw new Error(`runtime.js has no function ${name}`);
  return new Function(`${m[0]}\nreturn ${name};`)() as T;
}
const coreNiceTicks = runtimeFn<(lo: number, hi: number, n: number) => { lo: number; hi: number; ticks: number[] }>('niceTicks');
const coreGraphTick = runtimeFn<(v: number, span: number) => string>('graphTick');

const RES: ResidualSeries[] = [
  { key: 'u', label: 'U', color: '#1570ef', always: true },
  { key: 'p', label: 'p', color: '#6941c6', always: true },
  { key: 'k', label: 'k', color: '#12b76a' },
  { key: 'co', label: 'Co mean', color: '#d92d20', dashed: true, max_key: 'co_max' },
];
const KIT: LineSeries[] = RES.map((s) => ({ key: s.key, label: s.label, color: s.color, dashed: s.dashed }));

function decay(n: number, dt: number, withCo: boolean): LineRow[] {
  return Array.from({ length: n }, (_, i) => ({
    t: (i + 1) * dt,
    u: 0.5 * Math.exp(-i / 6) + 1e-6,
    p: 0.9 * Math.exp(-i / 9) + 3e-7,
    k: i % 5 === 0 ? 0 : 0.2 * Math.exp(-i / 4),
    ...(withCo ? { co: i > 3 ? 0.3 + i / 100 : 0 } : {}),
  }));
}

const CASES: Array<{ name: string; rows: LineRow[]; end: number; seconds: boolean }> = [
  { name: 'iterations, no planned end', rows: decay(40, 1, false), end: 0, seconds: false },
  { name: 'iterations, planned end past the data', rows: decay(25, 1, false), end: 200, seconds: false },
  { name: 'seconds, planned end, with a dashed metric', rows: decay(30, 0.01, true), end: 0.5, seconds: true },
  { name: 'seconds, no planned end', rows: decay(12, 2.5e-4, true), end: 0, seconds: true },
  { name: 'one value only', rows: [{ t: 1, u: 0.01 }], end: 0, seconds: false },
  { name: 'zeros and negatives are skipped', rows: [{ t: 1, u: 0, p: -1 }, { t: 2, u: 1e-3, p: 2e-3 }, { t: 3, u: 4e-4, p: 0 }], end: 10, seconds: false },
];

function kitGeometry(rows: LineRow[], end: number, seconds: boolean, height = 132) {
  return linePlotGeometry(rows, KIT, { xKey: 't', x: { kind: seconds ? 'seconds' : 'iterations', max: end }, y: { scale: 'log' }, height });
}

describe('linePlotGeometry, log scale', () => {
  for (const c of CASES) {
    it(`equals the core residual plot at height 132: ${c.name}`, () => {
      const core = plotGeometry(c.rows, c.end, c.seconds, RES);
      const kit = kitGeometry(c.rows, c.end, c.seconds);
      expect(core).not.toBeNull();
      expect(kit).not.toBeNull();
      if (!core || !kit) return;
      expect(kit.xmax).toBe(core.xmax);
      expect(kit.ticks).toEqual(core.decades);
      expect(kit.lines).toEqual(core.lines);
      expect(kit.metrics.map((s) => s.key)).toEqual(core.metrics.map((s) => s.key));
      for (const t of [0, 1, c.rows[0].t as number, core.xmax]) expect(kit.xOf(t)).toBe(core.xOf(t));
    });
  }

  it('draws nothing, as the core, before a positive value', () => {
    expect(plotGeometry([], 0, false, RES)).toBeNull();
    expect(kitGeometry([], 0, false)).toBeNull();
    expect(plotGeometry([{ t: 1, u: 0 }], 0, false, RES)).toBeNull();
    expect(kitGeometry([{ t: 1, u: 0 }], 0, false)).toBeNull();
  });

  it('keeps its text size on a taller plot: only the y positions scale', () => {
    const rows = decay(20, 1, false);
    const short = kitGeometry(rows, 0, false, 132);
    const tall = kitGeometry(rows, 0, false, 200);
    expect(tall?.ticks.map((d) => d.label)).toEqual(short?.ticks.map((d) => d.label));
    const span = (h: number) => h - PAD_T - PAD_B;
    const y = (g: typeof short, i: number) => (g ? g.ticks[i].y : NaN);
    expect((y(tall, 0) - PAD_T) / span(200)).toBeCloseTo((y(short, 0) - PAD_T) / span(132), 9);
    expect(tall?.xmax).toBe(short?.xmax);
  });

  it('takes a long run (more values than a spread call takes)', () => {
    const rows = Array.from({ length: 300_000 }, (_, i) => ({ t: i + 1, u: 1 / (i + 1) }));
    const g = linePlotGeometry(rows, [{ key: 'u', label: 'U' }], { xKey: 't', x: { kind: 'iterations' }, y: { scale: 'log' }, height: 132 });
    expect(g?.xmax).toBe(300_000);
    expect(g?.ticks.map((d) => d.label)).toEqual(['1e-5', '1e-4', '1e-3', '1e-2', '1e-1', '1']);
  });

  it('reads x from xKey', () => {
    const rows = decay(10, 1, false).map(({ t, ...rest }) => ({ iter: t, ...rest }));
    const g = linePlotGeometry(rows, KIT, { xKey: 'iter', x: { kind: 'iterations' }, y: { scale: 'log' }, height: 132 });
    expect(g?.xmax).toBe(10);
    expect(g?.lines[0].points).toBe(kitGeometry(decay(10, 1, false), 0, false)?.lines[0].points);
  });
});

describe('linePlotGeometry, linear scale', () => {
  const RANGES: Array<[number, number, number]> = [
    [0, 1, 5],
    [-3.2, 17.9, 5],
    [101300, 101420, 5],
    [1e-6, 3e-5, 5],
    [5, 5, 5],
    [0, 0.0123, 6],
    [-1e4, 2.5e4, 5],
    [0.25, 0.26, 5],
  ];

  it('niceTicks and graphTick equal the monitor graphs copies in runtime.js', () => {
    for (const [lo, hi, n] of RANGES) {
      const kit = niceTicks(lo, hi, n);
      expect(kit, `${lo}..${hi}`).toEqual(coreNiceTicks(lo, hi, n));
      for (const t of kit.ticks) expect(graphTick(t, kit.hi - kit.lo)).toBe(coreGraphTick(t, kit.hi - kit.lo));
    }
    for (const [v, span] of [[NaN, 1], [1234.5, 5000], [0.5, 0], [0, 0], [2.5e-5, 1e-4]]) {
      expect(graphTick(v, span)).toBe(coreGraphTick(v, span));
    }
  });

  it('labels its grid with those ticks, from the bottom of the plot to the top', () => {
    const rows = [
      { t: 1, dp: 101310 },
      { t: 2, dp: 101355.5 },
      { t: 3, dp: 101412 },
    ];
    const g = linePlotGeometry(rows, [{ key: 'dp', label: 'Pressure' }], {
      xKey: 't',
      x: { kind: 'iterations' },
      y: { scale: 'linear', unit: 'Pa' },
      height: 132,
    });
    const core = coreNiceTicks(101310, 101412, 5);
    expect(g?.ticks.map((d) => d.label)).toEqual(core.ticks.map((t) => coreGraphTick(t, core.hi - core.lo)));
    expect(g?.ticks[0].y).toBeCloseTo(132 - PAD_B, 9);
    expect(g?.ticks[g.ticks.length - 1].y).toBeCloseTo(PAD_T, 9);
    expect(g?.lines[0].color).toBe('var(--mg-series-1)');
  });

  it('draws zero and negative values, and skips missing ones', () => {
    const rows: LineRow[] = [{ t: 1, a: -2 }, { t: 2, a: 0 }, { t: 3 }, { t: 4, a: 3 }];
    const g = linePlotGeometry(rows, [{ key: 'a', label: 'A' }], { xKey: 't', x: { kind: 'iterations' }, y: { scale: 'linear' }, height: 132 });
    expect(g?.lines[0].points.split(' ')).toHaveLength(3);
    expect(linePlotGeometry([{ t: 1 }], [{ key: 'a', label: 'A' }], { xKey: 't', x: { kind: 'iterations' }, y: { scale: 'linear' }, height: 132 })).toBeNull();
  });
});

describe('linePlotGeometry, linear x axis', () => {
  const polar: LineRow[] = [-4, -2, 0, 2, 4, 6, 8, 10].map((a) => ({ alpha: a, cl: 0.11 * (a + 2) }));
  const axes = (x: Record<string, unknown> = {}) =>
    ({ xKey: 'alpha', x: { kind: 'linear', ...x }, y: { scale: 'linear' }, height: 132 }) as const;

  it('spans round ticks over the data, below zero too, and places every row inside the plot', () => {
    const g = linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], axes());
    expect(g?.xmin).toBe(-5);
    expect(g?.xmax).toBe(10);
    expect(g?.xTicks.map((t) => t.label)).toEqual(['-5', '0', '5', '10']);
    expect(g?.xTicks[0].x).toBeCloseTo(PAD_L, 9);
    expect(g?.xTicks[g.xTicks.length - 1].x).toBeCloseTo(PLOT_W - PAD_R, 9);
    const xs = g!.lines[0].points.split(' ').map((p) => Number(p.split(',')[0]));
    expect(xs[0]).toBeCloseTo(PAD_L + (1 / 15) * (PLOT_W - PAD_L - PAD_R), 1);
    expect(xs.every((x) => x >= PAD_L - 1e-9 && x <= PLOT_W - PAD_R + 1e-9)).toBe(true);
    expect(g?.xOf(0)).toBeCloseTo(PAD_L + (5 / 15) * (PLOT_W - PAD_L - PAD_R), 9);
  });

  it('lays out for the width it is drawn at: x spans that width, more ticks when wide, never fewer than at 280', () => {
    const narrow = linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], axes());
    expect(narrow?.width).toBe(PLOT_W);
    const wide = linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], { ...axes(), width: 1470 });
    expect(wide?.width).toBe(1470);
    expect(wide?.xOf(10)).toBeCloseTo(1470 - PAD_R, 9);
    expect(wide?.xTicks[wide.xTicks.length - 1].x).toBeCloseTo(1470 - PAD_R, 9);
    expect(wide!.xTicks.length).toBeGreaterThan(narrow!.xTicks.length);
    // The same y layout at any width (only x stretches).
    expect(wide?.ticks.map((t) => t.y)).toEqual(narrow?.ticks.map((t) => t.y));
    // An unknown or tiny width: never narrower than its labels need.
    expect(linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], { ...axes(), width: 0 })?.width).toBe(PLOT_W);
    expect(linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], { ...axes(), width: 20 })?.width).toBe(PAD_L + PAD_R + 60);
  });

  it('widens to min and max, and formats ticks with its own format', () => {
    const positive = polar.filter((r) => Number(r.alpha) >= 0);
    const deg = (v: number) => `${v}°`;
    let g = linePlotGeometry(positive, [{ key: 'cl', label: 'Cl' }], axes({ min: -10, format: deg }));
    expect(g?.xmin).toBe(-10);
    expect(g?.xmax).toBe(10);
    expect(g?.xTicks.map((t) => t.label)).toEqual(['-10°', '-5°', '0°', '5°', '10°']);
    g = linePlotGeometry(positive, [{ key: 'cl', label: 'Cl' }], axes({ max: 30, format: deg }));
    expect(g?.xTicks.map((t) => t.label)).toEqual(['0°', '10°', '20°', '30°']);
    // Data past min or max still shows: they only widen the axis.
    g = linePlotGeometry(polar, [{ key: 'cl', label: 'Cl' }], axes({ min: 0, max: 5 }));
    expect([g?.xmin, g?.xmax]).toEqual([-5, 10]);
  });

  it('draws rows in their order, so x may turn back (a drag polar), and keeps small x apart', () => {
    const rows: LineRow[] = [
      { cd: 0.012, cl: -0.4 },
      { cd: 0.006, cl: 0.2 },
      { cd: 0.009, cl: 0.9 },
    ];
    const g = linePlotGeometry(rows, [{ key: 'cl', label: 'Cl' }], { xKey: 'cd', x: { kind: 'linear' }, y: { scale: 'linear' }, height: 132 });
    const xs = g!.lines[0].points.split(' ').map((p) => Number(p.split(',')[0]));
    expect(xs[0]).toBeGreaterThan(xs[2]);
    expect(xs[2]).toBeGreaterThan(xs[1]);
    expect(xs[0] - xs[1]).toBeGreaterThan(100);
    expect(g?.xTicks.map((t) => t.label)).toEqual(['0.006', '0.008', '0.010', '0.012']);
  });

  it('labels ticks with the decimals of their step', () => {
    expect(xTickLabel(-4, 2)).toBe('-4');
    expect(xTickLabel(0.01, 0.005)).toBe('0.010');
    expect(xTickLabel(0.25, 0.25)).toBe('0.25');
    expect(xTickLabel(-1e-12, 0.5)).toBe('0.0');
    expect(xTickLabel(3, 1, (v) => `x${v}`)).toBe('x3');
  });

  it('leaves iterations and seconds as they were: from 0, no x ticks', () => {
    const rows = decay(10, 1, false);
    const g = kitGeometry(rows, 0, false);
    expect(g?.xmin).toBe(0);
    expect(g?.xTicks).toEqual([]);
  });
});

describe('legend, colours, hover', () => {
  const rows: LineRow[] = [{ t: 1, a: 0.1, c: 0.2 }];
  const series: LineSeries[] = [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B', legend: 'always' },
    { key: 'c', label: 'C', legend: 'never' },
    { key: 'd', label: 'D', legend: 'when-data' },
    { key: 'm', label: 'M', dashed: true },
    { key: 'n', label: 'N', dashed: true, color: 'var(--mg-danger)' },
  ];

  it('lists always, when-data once it has values, never never; dashed series once they have values', () => {
    expect(legendSeries(rows, series, 'log').map((s) => s.key)).toEqual(['a', 'b']);
    const withM = [...rows, { t: 2, m: 0.5, d: 1e-3 }];
    expect(legendSeries(withM, series, 'log').map((s) => s.key)).toEqual(['a', 'b', 'd', 'm']);
    // Log: zero is no value; linear: it is.
    expect(legendSeries([{ t: 1, d: 0 }], series, 'log').map((s) => s.key)).toEqual(['b']);
    expect(legendSeries([{ t: 1, d: 0 }], series, 'linear').map((s) => s.key)).toEqual(['b', 'd']);
    // A dashed series is listed once it has values, unless it says never.
    expect(legendSeries([{ t: 1, n: 1 }], [...series.slice(0, 5), { ...series[5], legend: 'never' }], 'log').map((s) => s.key)).toEqual(['b']);
  });

  it('colours a series by its place in the palette unless it has its own', () => {
    expect(seriesColor(series, series[0])).toBe('var(--mg-series-1)');
    expect(seriesColor(series, series[4])).toBe('var(--mg-series-5)');
    expect(seriesColor(series, series[5])).toBe('var(--mg-danger)');
    const many = Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: `S${i}` }));
    expect(seriesColor(many, many[7])).toBe('var(--mg-series-1)');
  });

  it('hovers the nearest row by x', () => {
    const r = [{ t: 1 }, { t: 2 }, { t: 4 }, { t: NaN }];
    expect(nearestRow(r, 't', 2.9)).toBe(r[1]);
    expect(nearestRow(r, 't', 3.1)).toBe(r[2]);
    expect(nearestRow([], 't', 1)).toBeNull();
  });

  it('puts the tip right of the pointer, and flips it left at the right edge', () => {
    expect(tipLeft(100, 80, 300)).toBe(108);
    expect(tipLeft(212, 80, 300)).toBe(220);
    expect(tipLeft(213, 80, 300)).toBe(125);
    // Never past the left edge.
    expect(tipLeft(60, 170, 200)).toBe(0);
  });
});
