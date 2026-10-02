import { colormapGradient, type ColormapName } from '../colormaps';
import { formatSci } from '../format/sci';

export interface ColorLegendProps {
  map: ColormapName;
  min: number;
  max: number;
  /** Shown above the bar, with the unit in brackets. */
  title?: string;
  unit?: string;
  /** Tick labels under the bar, ends included; default 5. */
  ticks?: number;
  /** A range centred on 0, [-m, m] with m = max(|min|, |max|), for the diverging maps (balance, curl). */
  centred?: boolean;
  /** Formats a tick; default formatSci. */
  format?: (v: number) => string;
}

/** The tick values: `count` evenly spaced over the range, ends included. */
export function legendTicks(min: number, max: number, count: number, centred: boolean): number[] {
  let lo = Number(min);
  let hi = Number(max);
  if (centred) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    lo = -m;
    hi = m;
  }
  const n = Math.max(2, Math.round(Number(count) || 0));
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? hi : lo + ((hi - lo) * i) / (n - 1)));
}

/** A colour scale: the same table the render uses (colormapGradient), with its range under it. */
export function ColorLegend({ map, min, max, title, unit, ticks = 5, centred = false, format = formatSci }: ColorLegendProps) {
  const head = title && unit ? `${title} (${unit})` : title || unit || '';
  return (
    <div className="mgk-type mgk-legend">
      {head ? <div className="mgk-legend-title">{head}</div> : null}
      <div className="mgk-legend-bar" style={{ background: colormapGradient(map) }} />
      <div className="mgk-legend-ticks">
        {legendTicks(min, max, ticks, centred).map((v, i) => (
          <span key={i}>{format(v)}</span>
        ))}
      </div>
    </div>
  );
}
