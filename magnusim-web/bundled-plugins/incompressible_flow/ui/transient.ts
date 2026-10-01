/**
 * The transient run settings as the run panel edits them: defaults, clamping
 * (the same limits as incompressible_flow.transient.normalize_transient, which
 * runs again when the case is written), the frame interval and the hint.
 */
import type { RunPreview } from '../../../src/panels/legacyBridge';

export interface TransientSettings {
  end_time: number;
  write_count: number;
  time_step_mode: string;
  max_co: number;
  delta_t: number | null;
  max_delta_t: number | null;
  time_scheme: string;
  n_outer_correctors: number;
  n_correctors: number;
  n_non_orth_correctors: number;
  [key: string]: unknown;
}

/** Seconds → short label (5 s, 0.1 s, 2.5e-4 s). */
export function formatSimTime(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0 s';
  const a = Math.abs(n);
  let s: string;
  if (a >= 100) s = n.toFixed(0);
  else if (a >= 10) s = n.toFixed(1);
  else if (a >= 1) s = String(Number(n.toFixed(2)));
  else if (a >= 0.01) s = String(Number(n.toFixed(3)));
  else if (a >= 1e-3) s = String(Number(n.toFixed(4)));
  else s = n.toExponential(1);
  return `${s} s`;
}

export function frameInterval(t: Partial<TransientSettings> | null | undefined): number {
  const frames = Math.max(1, Math.round(Number(t && t.write_count) || 1));
  const end = Number(t && t.end_time);
  return end > 0 ? end / frames : 0;
}

/**
 * Clamp and fill a settings object the way the form always has: `raw` over
 * `base` over the defaults; blank advanced values stay null (calculated).
 */
export function normalizeTransient(
  raw: Record<string, unknown> | null | undefined,
  base: Record<string, unknown>,
  defaults: Record<string, unknown>,
): TransientSettings {
  const src = raw || {};
  const num = (v: unknown, prev: unknown, opts?: { int?: boolean; nullable?: boolean }): number | null => {
    if (v === undefined) return prev as number | null;
    if (v === null || String(v).trim() === '') return opts && opts.nullable ? null : (prev as number | null);
    const n = Number(v);
    if (!Number.isFinite(n)) return prev as number | null;
    return opts && opts.int ? Math.round(n) : n;
  };
  const str = (v: unknown, prev: unknown) => (v ? String(v) : String(prev || ''));
  const b = { ...defaults, ...base };
  const out = {
    end_time: num(src.end_time, b.end_time) as number,
    write_count: num(src.write_count, b.write_count, { int: true }) as number,
    time_step_mode: str(src.time_step_mode, b.time_step_mode) === 'fixed' ? 'fixed' : 'adjustable',
    max_co: num(src.max_co, b.max_co) as number,
    delta_t: num(src.delta_t, b.delta_t, { nullable: true }),
    max_delta_t: num(src.max_delta_t, b.max_delta_t, { nullable: true }),
    time_scheme: str(src.time_scheme, b.time_scheme) === 'backward' ? 'backward' : 'Euler',
    n_outer_correctors: num(src.n_outer_correctors, b.n_outer_correctors, { int: true }) as number,
    n_correctors: num(src.n_correctors, b.n_correctors, { int: true }) as number,
    n_non_orth_correctors: num(src.n_non_orth_correctors, b.n_non_orth_correctors, { int: true }) as number,
  };
  if (!(out.end_time > 0)) out.end_time = Number(b.end_time) > 0 ? Number(b.end_time) : Number(defaults.end_time);
  if (!(out.write_count >= 1)) out.write_count = Number(defaults.write_count);
  out.write_count = Math.min(out.write_count, 5000);
  if (!(out.max_co > 0)) out.max_co = Number(defaults.max_co);
  if (out.delta_t != null && !(out.delta_t > 0)) out.delta_t = null;
  if (out.max_delta_t != null && !(out.max_delta_t > 0)) out.max_delta_t = null;
  const interval = frameInterval(out);
  if (out.max_delta_t != null && interval > 0 && out.max_delta_t > interval) out.max_delta_t = interval;
  out.n_outer_correctors = Math.min(Math.max(out.n_outer_correctors || 1, 1), 50);
  out.n_correctors = Math.min(Math.max(out.n_correctors || 1, 1), 10);
  out.n_non_orth_correctors = Math.min(Math.max(out.n_non_orth_correctors || 0, 0), 5);
  return out;
}

/** The hint under the transient inputs: frame interval, the calculated Δt, steps, flow-through. */
export function transientHint(t: TransientSettings, pv: RunPreview | null): { text: string; warn: string } {
  const ctrl = (pv && pv.control) as
    | {
        adjust_time_step?: boolean;
        delta_t?: number;
        max_co?: number;
        source?: { delta_t?: string };
        estimate?: { steps?: number; flow_through_s?: number };
      }
    | undefined;
  const frames = Math.max(1, Math.round(Number(t.write_count) || 1));
  const interval = Number(t.end_time) / frames;
  const bits: string[] = [];
  bits.push('A result frame every ' + formatSimTime(interval) + ' (' + frames + ' frames)');
  if ((t.time_step_mode || 'adjustable') !== 'fixed') {
    bits.push('max Δt limited to that interval so every frame is written');
  }
  if (ctrl) {
    const dtAuto = ctrl.source && ctrl.source.delta_t === 'auto';
    if (ctrl.adjust_time_step) {
      bits.push(
        (dtAuto ? 'starting Δt ≈ ' : 'starting Δt ') +
          formatSimTime(ctrl.delta_t) +
          (dtAuto ? ' (auto)' : '') +
          ', adjusted to keep Co ≤ ' +
          String(Number(ctrl.max_co)),
      );
    } else {
      bits.push('fixed Δt ' + formatSimTime(ctrl.delta_t) + (dtAuto ? ' (auto)' : ''));
    }
    const est = ctrl.estimate || {};
    if (Number.isFinite(est.steps) && Number(est.steps) > 0) {
      bits.push('roughly ' + Number(est.steps).toLocaleString() + ' time steps');
    }
    if (Number.isFinite(est.flow_through_s) && Number(est.flow_through_s) > 0) {
      bits.push('one flow-through of the domain ≈ ' + formatSimTime(est.flow_through_s));
    }
  }
  let warn = '';
  if (ctrl && ctrl.estimate && Number.isFinite(ctrl.estimate.steps) && Number(ctrl.estimate.steps) > 200000) {
    warn = 'That is a long run — a shorter simulation time, a coarser mesh or a higher Courant number (Advanced) will finish sooner.';
  } else if (pv && pv.partial) {
    warn = 'Assign a mesh and boundary conditions to see the calculated time step.';
  }
  return { text: bits.join(' · ') + '.', warn };
}
