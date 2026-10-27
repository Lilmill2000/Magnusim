import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { tipLeft } from '../../plugin-ui/data/linePlotGeometry';
import { formatSimTime } from '../../plugin-ui/format/time';
import { seriesVar } from '../../theme/series';
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
  /** A multi-region run's series: the region it was solved in (its key is `<region>:<key>`). */
  region?: string;
}

/**
 * Colors for series an analysis did not declare (a run read before the registry). A series keeps
 * its hex as its identity; it is painted through seriesVar, so the theme's series colour shows.
 */
const FALLBACK_COLORS = ['#1570ef', '#6941c6', '#12b76a', '#f79009', '#0ba5ec', '#dd2590', '#667085'];

/** The regions the rows name (keys `<region>:<field>`, a multi-region run), in order. */
export function residualRegions(rows: Array<Record<string, number | undefined>>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const at = k.indexOf(':');
      if (at > 0 && !out.includes(k.slice(0, at))) out.push(k.slice(0, at));
    }
  }
  return out;
}

/**
 * The declared series, else one per number the rows carry. In a multi-region run
 * each solved series is drawn once per region (`air:h`, `heater:h`): the first
 * region in its declared color, the next ones in colors of their own (fallback
 * colors no declared series uses, while there are any); dashed per-step metrics
 * stay as declared.
 */
export function seriesFor(rows: Array<Record<string, number | undefined>>, declared: ResidualSeries[]): ResidualSeries[] {
  const regions = residualRegions(rows);
  if (declared.length && !regions.length) return declared;
  if (!declared.length) {
    const keys: string[] = [];
    for (const row of rows) for (const k of Object.keys(row)) if (k !== 't' && !keys.includes(k)) keys.push(k);
    return keys.map((key, i) => {
      const at = key.indexOf(':');
      const region = at > 0 ? key.slice(0, at) : undefined;
      return { key, label: region ? key.slice(at + 1) : key, color: FALLBACK_COLORS[i % FALLBACK_COLORS.length], always: true, region };
    });
  }
  const out: ResidualSeries[] = [];
  const taken = new Set(declared.map((s) => String(s.color).toLowerCase()));
  const free = FALLBACK_COLORS.filter((c) => !taken.has(c.toLowerCase()));
  const spares = free.length ? free : FALLBACK_COLORS;
  let spare = 0;
  regions.forEach((region, r) => {
    for (const s of declared) {
      if (s.dashed) continue;
      const color = r === 0 ? s.color : spares[spare++ % spares.length];
      out.push({ ...s, key: `${region}:${s.key}`, color, swatch: r === 0 ? s.swatch : undefined, region, always: false });
    }
  });
  return [...out, ...declared.filter((s) => s.dashed)];
}

/** The legend's series in groups: one per region of a multi-region run, else one unnamed group. */
export function legendGroups(series: ResidualSeries[]): Array<{ region: string; series: ResidualSeries[] }> {
  const groups: Array<{ region: string; series: ResidualSeries[] }> = [];
  for (const s of series) {
    const region = s.region || '';
    let group = groups.find((g) => g.region === region);
    if (!group) {
      group = { region, series: [] };
      groups.push(group);
    }
    group.series.push(s);
  }
  return groups;
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
    <i className="sim-swatch" style={{ background: seriesVar(s.color) }} />
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
              <line className="mgk-plot-grid" x1={PAD_L} y1={d.y.toFixed(1)} x2={W - PAD_R} y2={d.y.toFixed(1)} />
              <text className="mgk-plot-label" x={PAD_L - 4} y={(d.y + 3).toFixed(1)} textAnchor="end" fontSize="8">
                {d.label}
              </text>
            </g>
          ))}
          <text className="mgk-plot-label" x={PAD_L} y={H - 4} fontSize="8">
            {seconds ? '0 s' : '1'}
          </text>
          <text className="mgk-plot-label" x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="8">
            {seconds ? formatSimTime(geo.xmax) : String(Math.round(geo.xmax))}
          </text>
          {geo.lines.map((l) => (
            <polyline
              key={l.key}
              fill="none"
              style={{ stroke: seriesVar(l.color) }}
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
                  <span style={{ color: seriesVar(s.color) }}>{s.region ? `${s.region} ${s.label}` : s.label}</span>{' '}
                  {Number(hover.row[s.key]).toExponential(1)}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="sim-residual-legend">
        {legendGroups([...legendSeries(rows, series), ...geo.metrics]).map((g) =>
          g.region ? (
            <span key={`region:${g.region}`} className="sim-residual-group" data-residual-region={g.region}>
              <b className="sim-residual-region">{g.region}</b>
              {g.series.map((s) => (
                <span key={s.key}>
                  <Swatch s={s} />
                  {s.label}
                </span>
              ))}
            </span>
          ) : (
            g.series.map((s) => (
              <span key={s.key}>
                <Swatch s={s} />
                {s.label}
              </span>
            ))
          ),
        )}
      </div>
    </>
  );
}
