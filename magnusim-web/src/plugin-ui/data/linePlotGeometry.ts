/**
 * LinePlot's geometry, apart from React so it can be tested on its own (not
 * named linePlot.ts: on Windows './LinePlot' would resolve to it). The
 * log scale is the core residual plot's (ResidualPlot.tsx plotGeometry); the
 * linear scale uses the monitor graphs' round ticks (runtime.js niceTicks and
 * graphTick).
 */

/** One plotted line. */
export interface LineSeries {
  /** The row key that holds its values. */
  key: string;
  label: string;
  /** A CSS colour; default var(--mg-series-N), by its place in `series`. */
  color?: string;
  /** A dashed per-step metric (as the core's Courant line): drawn and listed once it has values. */
  dashed?: boolean;
  /** Legend entry: always, once it has values (the default), or never. */
  legend?: 'always' | 'when-data' | 'never';
  /** Formats its value in the hover tip; default toExponential(1). */
  format?: (v: number) => string;
}

export type LineRow = Record<string, number | undefined>;

export interface LinePlotAxes {
  xKey: string;
  x: { kind: 'iterations' | 'seconds'; max?: number };
  y: { scale: 'log' | 'linear'; unit?: string };
  height: number;
}

/** The viewBox width; the height is the plot's own (default 132, as the core plot). */
export const PLOT_W = 280;
export const PLOT_H = 132;
export const PAD_L = 36;
export const PAD_R = 8;
export const PAD_T = 10;
export const PAD_B = 18;

export interface LinePlotGeometry {
  xmax: number;
  /** The dashed series that have values (drawn, listed and read out on hover). */
  metrics: LineSeries[];
  /** Horizontal grid lines with their labels: decades (log) or round ticks (linear). */
  ticks: Array<{ y: number; label: string }>;
  lines: Array<{ key: string; color: string; dashed: boolean; points: string }>;
  xOf: (x: number) => number;
}

/** The colour a series draws in: its own, else the kit's series palette by its place. */
export function seriesColor(series: LineSeries[], s: LineSeries): string {
  if (s.color) return s.color;
  const i = Math.max(0, series.indexOf(s));
  return `var(--mg-series-${(i % 7) + 1})`;
}

/** A value the scale can draw: positive on a log scale, finite on a linear one. */
export function drawable(v: unknown, scale: 'log' | 'linear'): boolean {
  const n = Number(v);
  return scale === 'log' ? Number.isFinite(n) && n > 0 : v != null && v !== '' && Number.isFinite(n);
}

/** Round ticks over [lo, hi], about n of them (runtime.js niceTicks, unchanged). */
export function niceTicks(lo: number, hi: number, n: number): { lo: number; hi: number; ticks: number[] } {
  if (!(hi > lo)) {
    const v = Number.isFinite(lo) ? lo : 0;
    return { lo: v - 1, hi: v + 1, ticks: [v - 1, v, v + 1] };
  }
  const span = hi - lo;
  const raw = span / Math.max(1, n - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const cand = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  const step = cand.find((c) => c >= raw) || cand[cand.length - 1];
  const t0 = Math.floor(lo / step) * step;
  const t1 = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = t0; t <= t1 + step * 1e-6; t += step) ticks.push(Math.round(t / step) * step);
  return { lo: t0, hi: t1, ticks };
}

/** A tick label for a value on an axis that spans `span` (runtime.js graphTick, unchanged). */
export function graphTick(v: number, span: number): string {
  if (!Number.isFinite(v)) return '';
  const s = Math.abs(span) || Math.abs(v) || 1;
  if (s >= 1000) return Math.round(v).toLocaleString('en-US');
  if (s >= 50) return v.toFixed(1);
  if (s >= 1) return v.toFixed(2);
  if (s >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

function xValue(row: LineRow, xKey: string): number {
  return Number(row[xKey]);
}

/** The geometry of one plot; null when nothing can be drawn yet. */
export function linePlotGeometry(rows: ReadonlyArray<LineRow>, series: LineSeries[], axes: LinePlotAxes): LinePlotGeometry | null {
  const { xKey, height } = axes;
  const scale = axes.y.scale;
  const plotted = rows.filter((r) => Number.isFinite(xValue(r, xKey)));
  if (!plotted.length) return null;
  let dataMax = 0;
  for (const r of plotted) {
    const t = xValue(r, xKey);
    if (t > dataMax) dataMax = t;
  }
  const planned = Number(axes.x.max) || 0;
  const xmax =
    axes.x.kind === 'seconds'
      ? planned > 0
        ? Math.max(planned, dataMax)
        : dataMax > 0
          ? dataMax
          : 1e-3
      : Math.max(planned, dataMax, 1);
  const metrics = series.filter((s) => s.dashed && plotted.some((r) => drawable(r[s.key], scale)));
  const drawn = [...series.filter((s) => !s.dashed), ...metrics];
  // The y range, in a loop: a long run has more values than a spread call takes.
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const row of plotted) {
    for (const s of drawn) {
      if (!drawable(row[s.key], scale)) continue;
      const v = scale === 'log' ? Math.log10(Number(row[s.key])) : Number(row[s.key]);
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }
  if (vmin > vmax) return null;
  const plotH = height - PAD_T - PAD_B;
  let y0: number;
  let y1: number;
  const ticks: LinePlotGeometry['ticks'] = [];
  if (scale === 'log') {
    y0 = vmin;
    y1 = vmax;
    if (y1 === y0) {
      y0 -= 1;
      y1 += 1;
    }
    const yPad = (y1 - y0) * 0.08;
    y0 -= yPad;
    y1 += yPad;
    for (let d = Math.ceil(y0); d <= Math.floor(y1); d++) {
      ticks.push({ y: PAD_T + (1 - (d - y0) / (y1 - y0)) * plotH, label: d === 0 ? '1' : d === 1 ? '10' : `1e${d}` });
    }
  } else {
    const nice = niceTicks(vmin, vmax, 5);
    y0 = nice.lo;
    y1 = nice.hi;
    for (const t of nice.ticks) ticks.push({ y: PAD_T + (1 - (t - y0) / (y1 - y0)) * plotH, label: graphTick(t, y1 - y0) });
  }
  const lo = y0;
  const hi = y1;
  const xOf = (t: number) => PAD_L + (Number(t) / xmax) * (PLOT_W - PAD_L - PAD_R);
  const yOf =
    scale === 'log'
      ? (v: number) => PAD_T + (1 - (Math.log10(Math.max(v, 1e-16)) - lo) / (hi - lo)) * plotH
      : (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * plotH;
  const lines: LinePlotGeometry['lines'] = [];
  for (const s of drawn) {
    const pts: string[] = [];
    for (const row of plotted) {
      if (drawable(row[s.key], scale)) pts.push(`${xOf(xValue(row, xKey)).toFixed(1)},${yOf(Number(row[s.key])).toFixed(1)}`);
    }
    if (pts.length) lines.push({ key: s.key, color: seriesColor(series, s), dashed: !!s.dashed, points: pts.join(' ') });
  }
  return { xmax, metrics, ticks, lines, xOf };
}

/** The legend: solid series by their legend rule, then the dashed ones that have values. */
export function legendSeries(rows: ReadonlyArray<LineRow>, series: LineSeries[], scale: 'log' | 'linear'): LineSeries[] {
  const has = (s: LineSeries) => rows.some((r) => drawable(r[s.key], scale));
  const solid = series.filter((s) => !s.dashed && s.legend !== 'never' && (s.legend === 'always' || has(s)));
  const dashed = series.filter((s) => s.dashed && s.legend !== 'never' && has(s));
  return [...solid, ...dashed];
}

/** The row nearest to x (by its x value), as the core plot's hover picks it. */
export function nearestRow(rows: ReadonlyArray<LineRow>, xKey: string, x: number): LineRow | null {
  let best: LineRow | null = null;
  let bd = Infinity;
  for (const row of rows) {
    const t = xValue(row, xKey);
    if (!Number.isFinite(t)) continue;
    const d = Math.abs(t - x);
    if (d < bd) {
      bd = d;
      best = row;
    }
  }
  return best;
}

/** The tip's left edge: right of the cursor, or left of it when it would pass the plot's right edge. */
export function tipLeft(x: number, tipWidth: number, plotWidth: number): number {
  if (x + 8 + tipWidth > plotWidth) return Math.max(0, x - 8 - tipWidth);
  return x + 8;
}

/** A value in the default tip: the series' own format, else toExponential(1). */
export function formatValue(s: LineSeries, v: number): string {
  return s.format ? s.format(v) : v.toExponential(1);
}
