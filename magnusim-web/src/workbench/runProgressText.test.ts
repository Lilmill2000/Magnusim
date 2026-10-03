import { describe, expect, it } from 'vitest';
import { formatSimTime } from '../plugin-ui/format/time';
import { LEGACY_LIVE_METRICS, liveMetricText, runProgressText, type LiveMetric } from './runProgressText';

/** runtime.js transientProgressText before the line read the analysis's live_metrics. */
function before(run: any, endTime: unknown, frames: string): string {
  const t =
    Number(run && run.sim_time != null ? run.sim_time : run && run.iteration) ||
    Number(run && run.last_saved_iteration) ||
    0;
  const end = Number(endTime) || 0;
  let s = 't = ' + formatSimTime(t) + (end > 0 ? ' / ' + formatSimTime(end) : '');
  if (end > 0 && t > 0) s += ' (' + Math.min(100, Math.floor((t / end) * 100)) + '%)';
  const extra = [];
  if (frames) extra.push(frames);
  if (run && Number.isFinite(Number(run.delta_t)) && Number(run.delta_t) > 0) extra.push('Δt ' + formatSimTime(run.delta_t));
  if (run && Number.isFinite(Number(run.co_mean))) {
    extra.push(
      'Co ' +
        Number(run.co_mean).toPrecision(2) +
        (Number.isFinite(Number(run.co_max)) ? ' (max ' + Number(run.co_max).toPrecision(2) + ')' : ''),
    );
  } else if (run && Number.isFinite(Number(run.co_max))) {
    extra.push('Co max ' + Number(run.co_max).toPrecision(2));
  }
  if (extra.length) s += ' · ' + extra.join(' · ');
  return s;
}

/** Incompressible Flow's transient analysis declares these (its registry row's live_metrics). */
const IF_METRICS: LiveMetric[] = [
  { key: 'delta_t', label: 'Δt', format: 'time', max_key: '' },
  { key: 'co_mean', label: 'Co', format: 'sig2', max_key: 'co_max' },
];

const RUNS: any[] = [
  { sim_time: 0.12, delta_t: 0.001, co_mean: 0.4213, co_max: 0.913 },
  { sim_time: 0.5, delta_t: 2.5e-4, co_mean: 0.05 },
  { sim_time: 1, co_max: 1.2 },
  { sim_time: 0.003, delta_t: 0, co_mean: 0 },
  { sim_time: 0.2, delta_t: '0.002', co_mean: '0.31', co_max: '0.7' },
  { iteration: 3, delta_t: -1, co_mean: null, co_max: undefined },
  { last_saved_iteration: 0.4 },
  { sim_time: 2.5, delta_t: 1e-6, co_mean: 12.345, co_max: 99.9 },
  {},
  null,
];

describe('runProgressText', () => {
  it("Incompressible Flow's declared metrics give the same line as before, for every input", () => {
    for (const run of RUNS) {
      for (const end of [0, 1, 0.25, null]) {
        for (const frames of ['', '4 / 10 frames']) {
          expect(runProgressText(run, end, { frames, metrics: IF_METRICS }), JSON.stringify({ run, end, frames })).toBe(before(run, end, frames));
        }
      }
    }
    expect(runProgressText(RUNS[0], 1, { frames: '4 / 10 frames', metrics: IF_METRICS })).toBe(
      't = 0.12 s / 1 s (12%) · 4 / 10 frames · Δt 0.001 s · Co 0.42 (max 0.91)',
    );
  });

  it('an analysis that declares none (null) keeps the line before API 1.5: Δt and Co', () => {
    for (const run of RUNS) {
      expect(runProgressText(run, 1, { frames: '2 frames', metrics: null })).toBe(before(run, 1, '2 frames'));
      expect(runProgressText(run, 1, { frames: '2 frames' })).toBe(before(run, 1, '2 frames'));
    }
    expect(LEGACY_LIVE_METRICS.map((m) => m.key)).toEqual(['delta_t', 'co_mean']);
  });

  it('[] shows none: only the time and the frames', () => {
    expect(runProgressText(RUNS[0], 1, { frames: '4 / 10 frames', metrics: [] })).toBe('t = 0.12 s / 1 s (12%) · 4 / 10 frames');
    expect(runProgressText(RUNS[0], 0, { metrics: [] })).toBe('t = 0.12 s');
  });

  it("an analysis's own numbers, in its order; a value the run lacks is left out", () => {
    const metrics: LiveMetric[] = [
      { key: 'co_mean', label: 'Courant', format: 'sig2', max_key: 'co_max' },
      { key: 'dt_wall', label: 'step', format: 'time' },
      { key: 'missing', label: 'Nothing', format: 'sig2' },
    ];
    expect(runProgressText({ sim_time: 0.5, co_mean: 0.25, dt_wall: 0.04 }, 1, { metrics })).toBe('t = 0.5 s / 1 s (50%) · Courant 0.25 · step 0.04 s');
    expect(runProgressText({ sim_time: 0.5 }, 1, { metrics })).toBe('t = 0.5 s / 1 s (50%)');
    expect(liveMetricText({ co_max: 2 }, metrics[0])).toBe('Courant max 2.0');
    expect(liveMetricText({}, metrics[2])).toBeNull();
    expect(liveMetricText({ dt_wall: 0 }, metrics[1]), 'a duration of zero is not shown').toBeNull();
  });
});
