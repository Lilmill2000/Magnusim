import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tipLeft } from '../../plugin-ui/data/linePlotGeometry';
import { formatSimTime } from '../../plugin-ui/format/time';
import type { ResidualRow } from './residuals';

/**
 * One plotted series, as the run's analysis declares it (contract
 * residual_series): its color and legend swatch, whether the legend always
 * lists it, and for a dashed per-step metric its max column in the readout.
 */
export interface ResidualSeries {
  key: string;
  label: string;
  color: string;
  always?: boolean;
  dashed?: boolean;
  max_key?: string;
  max_label?: string;
  swatch?: string;
}

/** Colors for series an analysis did not declare (a run read before the registry). */
const FALLBACK_COLORS = ['#1570ef', '#6941c6', '#12b76a', '#f79009', '#0ba5ec', '#dd2590', '#667085'];

/** The declared series, else one per number the rows carry. */
export function seriesFor(rows: Array<Record<string, number | undefined>>, declared: ResidualSeries[]): ResidualSeries[] {
  if (declared.length) return declared;
  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (k !== 't' && !keys.includes(k)) keys.push(k);
  return keys.map((key, i) => ({ key, label: key, color: FALLBACK_COLORS[i % FALLBACK_COLORS.length], always: true }));
}

const W = 280;
const H = 132;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 18;

type Row = ResidualRow & { [key: string]: number | undefined };

function plotNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
}

export interface PlotGeometry {
  xmax: number;
  /** The dashed per-step metrics that have values (drawn, and read out on hover). */
  metrics: ResidualSeries[];
  decades: Array<{ y: number; label: string }>;
  lines: Array<{ key: string; color: string; dashed: boolean; points: string }>;
  xOf: (t: number) => number;
}

/** Log-scale residual plot geometry; null when nothing positive has been written yet. */
export function plotGeometry(rows: Row[], endTime: number, seconds: boolean, series: ResidualSeries[]): PlotGeometry | null {
  if (!rows.length) return null;
  let dataMax = 0;
  for (const r of rows) {
    const t = Number(r.t);
    if (Number.isFinite(t) && t > dataMax) dataMax = t;
  }
  const planned = Number(endTime) || 0;
  const xmax = seconds ? (planned > 0 ? Math.max(planned, dataMax) : dataMax > 0 ? dataMax : 1e-3) : Math.max(planned, dataMax, 1);
  const metrics = series.filter((s) => s.dashed && rows.some((r) => Number(r[s.key]) > 0));
  const drawn = [...series.filter((s) => !s.dashed), ...metrics];
  const logs: number[] = [];
  for (const row of rows) {
    for (const s of drawn) {
      const v = Number(row[s.key]);
      if (Number.isFinite(v) && v > 0) logs.push(Math.log10(v));
    }
  }
  if (!logs.length) return null;
  let y0 = Math.min(...logs);
  let y1 = Math.max(...logs);
  if (y1 === y0) {
    y0 -= 1;
    y1 += 1;
  }
  const yPad = (y1 - y0) * 0.08;
  y0 -= yPad;
  y1 += yPad;
  const xOf = (t: number) => PAD_L + (Number(t) / xmax) * (W - PAD_L - PAD_R);
  const yOf = (v: number) => PAD_T + (1 - (Math.log10(Math.max(v, 1e-16)) - y0) / (y1 - y0)) * (H - PAD_T - PAD_B);
  const decades: PlotGeometry['decades'] = [];
  for (let d = Math.ceil(y0); d <= Math.floor(y1); d++) {
    decades.push({ y: PAD_T + (1 - (d - y0) / (y1 - y0)) * (H - PAD_T - PAD_B), label: d === 0 ? '1' : d === 1 ? '10' : `1e${d}` });
  }
  const lines: PlotGeometry['lines'] = [];
  for (const s of drawn) {
    const pts: string[] = [];
    for (const row of rows) {
      const v = Number(row[s.key]);
      if (Number.isFinite(v) && v > 0) pts.push(`${xOf(Number(row.t)).toFixed(1)},${yOf(v).toFixed(1)}`);
    }
    if (pts.length) lines.push({ key: s.key, color: s.color, dashed: !!s.dashed, points: pts.join(' ') });
  }
  return { xmax, metrics, decades, lines, xOf };
}

/** The legend: series the analysis always lists, and the others once the run solves them. */
export function legendSeries(rows: Row[], series: ResidualSeries[]) {
  return series.filter((s) => !s.dashed && (s.always || rows.some((r) => Number(r[s.key]) > 0)));
}

function Swatch({ s }: { s: ResidualSeries }) {
  return s.swatch ? (
    <i className={`sim-swatch sim-swatch-${s.swatch}`} />
  ) : (
    <i className="sim-swatch" style={{ background: s.color }} />
  );
}

/** Residuals (log scale) with the V0.1.0 legend and hover readout; x in seconds or iterations. */
export function ResidualPlot({
  rows,
  endTime,
  seconds,
  series: declared,
}: {
  rows: Row[];
  endTime: number;
  seconds: boolean;
  series: ResidualSeries[];
}) {
  const series = useMemo(() => seriesFor(rows, declared), [rows, declared]);
  const geo = useMemo(() => plotGeometry(rows, endTime, seconds, series), [rows, endTime, seconds, series]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ row: Row; x: number; width: number } | null>(null);
  const [left, setLeft] = useState(0);
  // Place the tip once its width is known: flipped left of the cursor near the right edge.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!hover || !el) return;
    setLeft(tipLeft(hover.x, el.getBoundingClientRect().width, hover.width));
  }, [hover]);
  if (!geo) return null;

  function onMove(e: React.PointerEvent) {
    const svg = svgRef.current;
    if (!svg || !geo) return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const sx = ((e.clientX - r.left) / r.width) * W;
    const t = ((sx - PAD_L) / (W - PAD_L - PAD_R)) * geo.xmax;
    let best = rows[0];
    let bd = Infinity;
    for (const row of rows) {
      const d = Math.abs(Number(row.t) - t);
      if (d < bd) {
        bd = d;
        best = row;
      }
    }
    setHover({ row: best, x: (geo.xOf(Number(best.t)) / W) * r.width, width: r.width });
  }

  return (
    <>
      <div className="sim-residual-wrap" onPointerMove={onMove} onPointerLeave={() => setHover(null)} data-residual-wrap="1">
        <svg
          ref={svgRef}
          className="sim-residual-plot"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Residuals"
          data-residual-plot="1"
        >
          {geo.decades.map((d) => (
            <g key={d.label}>
              <line x1={PAD_L} y1={d.y.toFixed(1)} x2={W - PAD_R} y2={d.y.toFixed(1)} stroke="#eaecf0" strokeWidth="1" />
              <text x={PAD_L - 4} y={(d.y + 3).toFixed(1)} textAnchor="end" fontSize="8" fill="#98a2b3">
                {d.label}
              </text>
            </g>
          ))}
          <text x={PAD_L} y={H - 4} fontSize="8" fill="#98a2b3">
            {seconds ? '0 s' : '1'}
          </text>
          <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="8" fill="#98a2b3">
            {seconds ? formatSimTime(geo.xmax) : String(Math.round(geo.xmax))}
          </text>
          {geo.lines.map((l) => (
            <polyline
              key={l.key}
              fill="none"
              stroke={l.color}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeDasharray={l.dashed ? '4 2' : undefined}
              points={l.points}
            />
          ))}
        </svg>
        {hover ? (
          <>
            <div className="sim-plot-cursor" style={{ left: `${hover.x.toFixed(1)}px` }} />
            <div ref={tipRef} className="sim-plot-tip" style={{ left: `${left.toFixed(1)}px` }}>
              <b>{seconds ? `t = ${formatSimTime(Number(hover.row.t))}` : `Iteration ${Math.round(Number(hover.row.t))}`}</b>
              {geo.metrics
                .filter((m) => Number.isFinite(Number(hover.row[m.key])))
                .map((m) => (
                  <Fragment key={m.key}>
                    <br />
                    <span className={m.swatch || 'metric'}>
                      {m.label} {plotNum(Number(hover.row[m.key]))}
                      {m.max_key && Number.isFinite(Number(hover.row[m.max_key]))
                        ? ` · ${m.max_label || 'max'} ${plotNum(Number(hover.row[m.max_key]))}`
                        : ''}
                    </span>
                  </Fragment>
                ))}
              <br />
              {series.filter((s) => !s.dashed && Number(hover.row[s.key]) > 0).map((s, i) => (
                <span key={s.key}>
                  {i ? ' · ' : ''}
                  <span style={{ color: s.color }}>{s.label}</span> {Number(hover.row[s.key]).toExponential(1)}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="sim-residual-legend">
        {[...legendSeries(rows, series), ...geo.metrics].map((s) => (
          <span key={s.key}>
            <Swatch s={s} />
            {s.label}
          </span>
        ))}
      </div>
    </>
  );
}
