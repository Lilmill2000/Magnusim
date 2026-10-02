/**
 * Time labels, one copy of each for the core and plugins: simulated time,
 * wall-clock elapsed time and the time left.
 */

function simTimeDigits(n: number): string {
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  if (a >= 1) return String(Number(n.toFixed(2)));
  if (a >= 0.01) return String(Number(n.toFixed(3)));
  if (a >= 1e-3) return String(Number(n.toFixed(4)));
  return n.toExponential(1);
}

/** Seconds → short label (5 s, 0.1 s, 2.5e-4 s). No number (null, '', NaN): —. */
export function formatSimTime(v: unknown, opts?: { noUnit?: boolean }): string {
  if (v == null || (typeof v === 'string' && !v.trim())) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const unit = opts && opts.noUnit ? '' : ' s';
  if (n === 0) return '0' + unit;
  const s = simTimeDigits(n);
  // Rounding can carry into the next band (99.95 → "100.0"): label the rounded number in its own band.
  const rounded = Number(s);
  return (Math.abs(rounded) > Math.abs(n) ? simTimeDigits(rounded) : s) + unit;
}

/** Milliseconds → m:ss, or h:mm:ss from one hour. Not a number: 0:00. */
export function formatElapsed(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '0:00';
  const s = Math.max(0, Math.floor(n / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return m + ':' + String(sec).padStart(2, '0');
}

/** Milliseconds left → "< 10s left" or "~m:ss left"; null when unknown. */
export function formatEta(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 8000) return '< 10s left';
  return '~' + formatElapsed(n) + ' left';
}
