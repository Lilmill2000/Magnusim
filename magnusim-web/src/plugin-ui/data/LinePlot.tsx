import { Fragment, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { formatSimTime } from '../format/time';
import {
  drawable,
  formatValue,
  legendSeries,
  linePlotGeometry,
  nearestRow,
  PAD_L,
  PAD_R,
  PLOT_H,
  PLOT_W,
  seriesColor,
  tipLeft,
  type LineRow,
  type LineSeries,
} from './linePlotGeometry';

export type { LineSeries } from './linePlotGeometry';

export interface LinePlotProps {
  rows: ReadonlyArray<Record<string, number | undefined>>;
  series: LineSeries[];
  /** The plot's accessible name (role=img). */
  label: string;
  /** The row key of the x value; default 't'. */
  xKey?: string;
  /** Iterations (labelled 1 … n) or simulated seconds (0 s … end); `max` is the planned end. */
  x: { kind: 'iterations' | 'seconds'; max?: number };
  /** Log (decades; values ≤ 0 are skipped) or linear (round ticks). `unit` is shown under the y labels. */
  y: { scale: 'log' | 'linear'; unit?: string };
  /** Default true. */
  legend?: boolean;
  /** Plot height in px (and viewBox units); default 132, as the core residual plot. */
  height?: number;
  /** The hover tip's content for a row; default: x, then the dashed series, then the solid ones. */
  tip?: (row: Record<string, number | undefined>) => ReactNode;
}

interface Hover {
  row: LineRow;
  /** The cursor's x in px from the plot's left edge. */
  x: number;
  /** The plot's width in px. */
  width: number;
}

/** The core residual plot's readout: x, then each dashed series, then the solid series on one line. */
function DefaultTip({
  row,
  xKey,
  seconds,
  series,
  metrics,
  scale,
}: {
  row: LineRow;
  xKey: string;
  seconds: boolean;
  series: LineSeries[];
  metrics: LineSeries[];
  scale: 'log' | 'linear';
}) {
  const xv = Number(row[xKey]);
  return (
    <>
      <b className="mgk-plot-tip-head">{seconds ? `t = ${formatSimTime(xv)}` : `Iteration ${Math.round(xv)}`}</b>
      {metrics
        .filter((m) => Number.isFinite(Number(row[m.key])))
        .map((m) => (
          <Fragment key={m.key}>
            <br />
            <span>
              {m.label} {formatValue(m, Number(row[m.key]))}
            </span>
          </Fragment>
        ))}
      <br />
      {series
        .filter((s) => !s.dashed && drawable(row[s.key], scale))
        .map((s, i) => (
          <span key={s.key}>
            {i ? ' · ' : ''}
            <span style={{ color: seriesColor(series, s) }}>{s.label}</span> {formatValue(s, Number(row[s.key]))}
          </span>
        ))}
    </>
  );
}

/** A small line chart (the core's residual plot, generalised): log or linear y, a hover readout and a legend. */
export function LinePlot({ rows, series, label, xKey = 't', x, y, legend = true, height = PLOT_H, tip }: LinePlotProps) {
  const xKind = x.kind;
  const xMax = x.max;
  const scale = y.scale;
  const seconds = xKind === 'seconds';
  const geo = useMemo(
    () => linePlotGeometry(rows, series, { xKey, x: { kind: xKind, max: xMax }, y: { scale }, height }),
    [rows, series, xKey, xKind, xMax, scale, height],
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [left, setLeft] = useState(0);

  // Place the tip once its width is known: flipped left of the cursor near the right edge.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!hover || !el) return;
    setLeft(tipLeft(hover.x, el.getBoundingClientRect().width, hover.width));
  }, [hover]);

  if (!geo) return null;
  const g = geo;

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const sx = ((e.clientX - r.left) / r.width) * PLOT_W;
    const t = ((sx - PAD_L) / (PLOT_W - PAD_L - PAD_R)) * g.xmax;
    const row = nearestRow(rows, xKey, t);
    if (!row) return;
    setHover({ row, x: (g.xOf(Number(row[xKey])) / PLOT_W) * r.width, width: r.width });
  }

  return (
    <div className="mgk-type mgk-linechart">
      <div className="mgk-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg
          ref={svgRef}
          className="mgk-plot-svg"
          viewBox={`0 0 ${PLOT_W} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          style={{ height: `${height}px` }}
        >
          {g.ticks.map((d, i) => (
            <g key={i}>
              <line className="mgk-plot-grid" x1={PAD_L} y1={d.y.toFixed(1)} x2={PLOT_W - PAD_R} y2={d.y.toFixed(1)} />
              <text className="mgk-plot-label" x={PAD_L - 4} y={(d.y + 3).toFixed(1)} textAnchor="end" fontSize="8">
                {d.label}
              </text>
            </g>
          ))}
          <text className="mgk-plot-label" x={PAD_L} y={height - 4} fontSize="8">
            {seconds ? '0 s' : '1'}
          </text>
          <text className="mgk-plot-label" x={PLOT_W - PAD_R} y={height - 4} textAnchor="end" fontSize="8">
            {seconds ? formatSimTime(g.xmax) : String(Math.round(g.xmax))}
          </text>
          {y.unit ? (
            <text className="mgk-plot-label" x={PAD_L - 4} y={height - 4} textAnchor="end" fontSize="8">
              {y.unit}
            </text>
          ) : null}
          {g.lines.map((l) => (
            <polyline
              key={l.key}
              className={l.dashed ? 'mgk-plot-line mgk-plot-line--dashed' : 'mgk-plot-line'}
              style={{ stroke: l.color }}
              points={l.points}
            />
          ))}
        </svg>
        <div className="mgk-plot-cursor" hidden={!hover} style={hover ? { left: `${hover.x.toFixed(1)}px` } : undefined} />
        <div ref={tipRef} className="mgk-plot-tip" hidden={!hover} style={hover ? { left: `${left.toFixed(1)}px` } : undefined}>
          {hover ? (
            tip ? (
              tip(hover.row)
            ) : (
              <DefaultTip row={hover.row} xKey={xKey} seconds={seconds} series={series} metrics={g.metrics} scale={scale} />
            )
          ) : null}
        </div>
      </div>
      {legend ? (
        <div className="mgk-plot-legend">
          {legendSeries(rows, series, scale).map((s) => {
            const c = seriesColor(series, s);
            return (
              <span key={s.key} className="mgk-plot-key">
                <i
                  className="mgk-plot-swatch"
                  style={{ background: s.dashed ? `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 6px)` : c }}
                />
                {s.label}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
