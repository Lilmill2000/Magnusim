/**
 * The Run panel's progress line of a run on a seconds axis: the simulated time, the
 * share of the end time, the result frames, then the per-step numbers its analysis
 * declares (AnalysisType.live_metrics, API 1.5: {key, label, format, max_key}). An
 * analysis that declares none (null in its registry row) keeps the line before 1.5:
 * Δt and Co. Each number comes from the run doc (its live progress); one it does
 * not have is left out.
 */
import { formatSimTime } from '../plugin-ui/format/time';

export type LiveMetric = {
  key: string;
  label: string;
  format: 'time' | 'sig2' | string;
  max_key?: string | null;
};

/** The numbers an analysis that declares no live_metrics shows (the line before API 1.5). */
export const LEGACY_LIVE_METRICS: readonly LiveMetric[] = Object.freeze([
  { key: 'delta_t', label: 'Δt', format: 'time' },
  { key: 'co_mean', label: 'Co', format: 'sig2', max_key: 'co_max' },
]);

type RunDoc = Record<string, unknown> | null | undefined;

/** A field of the run as a shown number, or null: a duration only when above zero. */
function metricValue(run: RunDoc, key: string | null | undefined, format: string): { raw: unknown; n: number } | null {
  if (!run || !key) return null;
  const raw = run[key];
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (format === 'time' && !(n > 0)) return null;
  return { raw, n };
}

function formatMetric(v: { raw: unknown; n: number }, format: string): string {
  return format === 'time' ? formatSimTime(v.raw) : v.n.toPrecision(2);
}

/** One live number's text ("Δt 1e-3 s", "Co 0.42 (max 0.9)", "Co max 0.9"), or null when the run has none. */
export function liveMetricText(run: RunDoc, m: LiveMetric): string | null {
  const format = String(m.format || '');
  const value = metricValue(run, m.key, format);
  const max = m.max_key ? metricValue(run, m.max_key, format) : null;
  if (value) return `${m.label} ${formatMetric(value, format)}` + (max ? ` (max ${formatMetric(max, format)})` : '');
  if (max) return `${m.label} max ${formatMetric(max, format)}`;
  return null;
}

/**
 * "t = 0.12 s / 1 s (12%) · 4 / 10 frames · Δt 1e-3 s · Co 0.42 (max 0.9)".
 * @param run the run doc (sim_time, iteration, last_saved_iteration and the metrics' fields)
 * @param endTime the run's end time in seconds (0: none)
 * @param opts frames: the result-frame label ('' for none); metrics: the analysis's
 *   live_metrics (null or undefined: not declared, the line before API 1.5; []: none)
 */
export function runProgressText(
  run: RunDoc,
  endTime: unknown,
  opts: { frames?: string | null; metrics?: readonly LiveMetric[] | null } = {},
): string {
  const t =
    Number(run && run.sim_time != null ? run.sim_time : run && run.iteration) || Number(run && run.last_saved_iteration) || 0;
  const end = Number(endTime) || 0;
  let s = 't = ' + formatSimTime(t) + (end > 0 ? ' / ' + formatSimTime(end) : '');
  if (end > 0 && t > 0) s += ' (' + Math.min(100, Math.floor((t / end) * 100)) + '%)';
  const extra: string[] = [];
  if (opts.frames) extra.push(opts.frames);
  const metrics = Array.isArray(opts.metrics) ? opts.metrics : LEGACY_LIVE_METRICS;
  for (const m of metrics) {
    const text = m && m.key ? liveMetricText(run, m) : null;
    if (text) extra.push(text);
  }
  if (extra.length) s += ' · ' + extra.join(' · ');
  return s;
}
