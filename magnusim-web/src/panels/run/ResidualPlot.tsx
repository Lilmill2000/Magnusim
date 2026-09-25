import { useMemo, useRef, useState } from 'react';
import type { ResidualRow } from './residuals';

/** V0.1.0 residual colors (runtime SIM_RES_SERIES / SIM_CO_SERIES). */
export const RES_SERIES = [
  { key: 'U', label: 'U', color: '#1570ef' },
  { key: 'p', label: 'p', color: '#6941c6' },
  { key: 'k', label: 'k', color: '#12b76a' },
  { key: 'omega', label: 'ω', color: '#f79009' },
  { key: 'epsilon', label: 'ε', color: '#0ba5ec' },
  { key: 'R', label: 'R', color: '#dd2590' },
] as const;
const CO_SERIES = { key: 'co_mean', label: 'Co mean', color: '#d92d20' } as const;

const W = 280;
const H = 132;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 18;

type Row = ResidualRow & { co_max?: number; [key: string]: number | undefined };

/** Seconds → short label (5 s, 0.1 s, 2.5e-4 s), as the runtime's formatSimTime. */
export function formatSimTime(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0 s';
  const a = Math.abs(v);
  let s: string;
  if (a >= 100) s = v.toFixed(0);
  else if (a >= 10) s = v.toFixed(1);
  else if (a >= 1) s = String(Number(v.toFixed(2)));
  else if (a >= 0.01) s = String(Number(v.toFixed(3)));
  else if (a >= 1e-3) s = String(Number(v.toFixed(4)));
  else s = v.toExponential(1);
  return `${s} s`;
}

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
  hasCo: boolean;
  decades: Array<{ y: number; label: string }>;
  lines: Array<{ key: string; color: string; dashed: boolean; points: string }>;
  xOf: (t: number) => number;
}

/** Log-scale residual plot geometry; null when nothing positive has been written yet. */
export function plotGeometry(rows: Row[], endTime: number, transient: boolean): PlotGeometry | null {
  if (!rows.length) return null;
  let dataMax = 0;
  for (const r of rows) {
    const t = Number(r.t);
    if (Number.isFinite(t) && t > dataMax) dataMax = t;
  }
  const planned = Number(endTime) || 0;
  const xmax = transient ? (planned > 0 ? Math.max(planned, dataMax) : dataMax > 0 ? dataMax : 1e-3) : Math.max(planned, dataMax, 1);
  const hasCo = transient && rows.some((r) => Number(r.co_mean) > 0);
  const drawn = hasCo ? [...RES_SERIES, CO_SERIES] : [...RES_SERIES];
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
    if (pts.length) lines.push({ key: s.key, color: s.color, dashed: s === CO_SERIES, points: pts.join(' ') });
  }
  return { xmax, hasCo, decades, lines, xOf };
}

/** U and p always; turbulence series only when this run solves them (laminar has none). */
export function legendSeries(rows: Row[]) {
  return RES_SERIES.filter((s) => s.key === 'U' || s.key === 'p' || rows.some((r) => Number(r[s.key]) > 0));
}

/** Residuals (log scale) with the V0.1.0 legend and hover readout. */
export function ResidualPlot({ rows, endTime, transient }: { rows: Row[]; endTime: number; transient: boolean }) {
  const geo = useMemo(() => plotGeometry(rows, endTime, transient), [rows, endTime, transient]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ row: Row; x: number } | null>(null);
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
    setHover({ row: best, x: (geo.xOf(Number(best.t)) / W) * r.width });
  }

  const tipLeft = hover ? hover.x + 8 : 0;
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
            {transient ? '0 s' : '1'}
          </text>
          <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="8" fill="#98a2b3">
            {transient ? formatSimTime(geo.xmax) : String(Math.round(geo.xmax))}
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
            <div className="sim-plot-tip" style={{ left: `${tipLeft.toFixed(1)}px` }}>
              <b>{transient ? `t = ${formatSimTime(Number(hover.row.t))}` : `Iteration ${Math.round(Number(hover.row.t))}`}</b>
              {geo.hasCo && Number.isFinite(Number(hover.row.co_mean)) ? (
                <>
                  <br />
                  <span className="co">
                    Co mean {plotNum(Number(hover.row.co_mean))}
                    {Number.isFinite(Number(hover.row.co_max)) ? ` · max ${plotNum(Number(hover.row.co_max))}` : ''}
                  </span>
                </>
              ) : null}
              <br />
              {RES_SERIES.filter((s) => Number(hover.row[s.key]) > 0).map((s, i) => (
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
        {legendSeries(rows).map((s) => (
          <span key={s.key}>
            <i className={`sim-swatch sim-swatch-${s.key === 'omega' ? 'w' : s.key.toLowerCase()}`} />
            {s.label}
          </span>
        ))}
        {geo.hasCo ? (
          <span>
            <i className="sim-swatch sim-swatch-co" />
            Co mean
          </span>
        ) : null}
      </div>
    </>
  );
}
