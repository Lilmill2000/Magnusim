/**
 * Time labels, one copy of each: simulated time, wall-clock elapsed time and
 * the time left. The core still has its own copies (see ROADMAP).
 */

/** Seconds → short label (5 s, 0.1 s, 2.5e-4 s). */
export function formatSimTime(v: unknown, opts?: { noUnit?: boolean }): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const unit = opts && opts.noUnit ? '' : ' s';
  if (n === 0) return '0' + unit;
  const a = Math.abs(n);
  let s: string;
  if (a >= 100) s = n.toFixed(0);
  else if (a >= 10) s = n.toFixed(1);
  else if (a >= 1) s = String(Number(n.toFixed(2)));
  else if (a >= 0.01) s = String(Number(n.toFixed(3)));
  else if (a >= 1e-3) s = String(Number(n.toFixed(4)));
  else s = n.toExponential(1);
  return s + unit;
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
