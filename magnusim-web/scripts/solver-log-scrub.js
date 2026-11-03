// @ts-check
/**
 * One scrub for every solver-log text the app keeps or shows (RH1, spec 3.7): the lines the
 * solver-log route serves, a run's health evidence and warning words, and its failed_reason,
 * before they are stored (relayEvent, healthPatch, applyStatus) and again before they are
 * served (the routes and the Assistant's host tools). FATAL lines routinely carry
 * /home/<user>/... and OpenFOAM source paths.
 *
 * - The Host, PID, Case and Hosts (...) header lines are dropped.
 * - Host names become <host>: os.hostname(), the names inside a "(host n)" list, and the
 *   name on the log's own "Host :" line (WSL's host name can differ from Windows').
 * - The OS user name becomes <user>.
 * - /home/<u>/..., /mnt/<d>/..., X:\..., \\wsl$\... and OpenFOAM source paths (/opt/...,
 *   .../src/...) become <path>.
 * - CR and control characters go; each line is cut to 240 characters.
 * - Then the Assistant's redact() (provider keys, bearer tokens).
 */
import { hostname, userInfo } from 'node:os';
import { redact } from './server/assistant/redact.ts';

export const SCRUB_LINE_MAX = 240;

/** The header lines dropped from served output. */
const HEADER_DROP = /^\s*(?:Host|PID|Case)\s*:|^\s*Hosts\s*:/;
/** A "(name n)" row of the Hosts list. */
const HOSTS_ROW = /^\s*\(\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\d+\s*\)\s*$/;
/** The log's own "Host : name" header. */
const HOST_HEADER = /^\s*Host\s*:\s*"?([^"\s]+)"?\s*$/m;
const PATHS = [
  /\\\\wsl(?:\$|\.localhost)\\[^\s"'`)]*/gi,
  /\b[A-Za-z]:[\\/][^\s"'`)]*/g,
  /\/home\/[^\s"'`)]+/g,
  /\/mnt\/[a-z]\/[^\s"'`)]*/gi,
  /\/(?:opt|usr|root|tmp)\/[^\s"'`)]+/g,
  /[^\s"'`(]*\/src\/[^\s"'`)]+/g,
];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * The host name a log says it ran on (its "Host :" header), or null; `head` is its first lines.
 * @param {string} head
 */
export function logHostOf(head) {
  const m = HOST_HEADER.exec(String(head || '').slice(0, 4096));
  return m ? m[1] : null;
}

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What to hide: the host names and the user name (this PC's, and the log's own host).
 * @param {{ logHost?: string | null, hosts?: string[] }} [extra]
 */
export function scrubContext(extra = {}) {
  /** @type {Set<string>} */
  const hosts = new Set();
  try {
    const h = hostname();
    if (h) hosts.add(h);
  } catch {
    /* no name */
  }
  if (extra.logHost) hosts.add(String(extra.logHost));
  for (const h of extra.hosts || []) if (h) hosts.add(String(h));
  let user = '';
  try {
    user = userInfo().username || '';
  } catch {
    user = '';
  }
  return { hosts: [...hosts].filter((h) => h.length > 1), user: user.length > 1 ? user : '' };
}

/**
 * One line of solver text as it may be kept or shown, or null when it is a header line to drop.
 * @param {unknown} line
 * @param {{ hosts: string[], user: string }} ctx
 * @param {{ keepHeader?: boolean }} [opts]
 * @returns {string | null}
 */
export function scrubLine(line, ctx, opts = {}) {
  let s = String(line ?? '').replace(/\r/g, '').replace(CONTROL, '');
  if (!opts.keepHeader && HEADER_DROP.test(s)) return null;
  const row = HOSTS_ROW.exec(s);
  if (row) s = s.replace(row[1], '<host>');
  for (const re of PATHS) s = s.replace(re, '<path>');
  for (const h of ctx.hosts) s = s.replace(new RegExp(`\\b${esc(h)}\\b`, 'gi'), '<host>');
  if (ctx.user) s = s.replace(new RegExp(`\\b${esc(ctx.user)}\\b`, 'gi'), '<user>');
  s = redact(s);
  return s.length > SCRUB_LINE_MAX ? s.slice(0, SCRUB_LINE_MAX) : s;
}

/**
 * A text kept in a run record (a finding's evidence, a warning, failed_reason): scrubbed, never dropped.
 * @param {unknown} text
 * @param {{ hosts: string[], user: string }} ctx
 * @param {number} [max]
 */
export function scrubText(text, ctx, max = SCRUB_LINE_MAX) {
  const s = scrubLine(text, ctx, { keepHeader: true }) ?? '';
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * A health record with its words scrubbed: each finding's evidence text and words, and each warning.
 * @param {any} health
 * @param {{ hosts: string[], user: string }} ctx
 */
export function scrubHealth(health, ctx) {
  if (!health || typeof health !== 'object') return health;
  const out = { ...health };
  if (Array.isArray(out.findings)) {
    out.findings = out.findings.map((/** @type {any} */ f) => {
      if (!f || typeof f !== 'object') return f;
      const g = { ...f };
      if (typeof g.text === 'string') g.text = scrubText(g.text, ctx, 240);
      if (g.evidence && typeof g.evidence === 'object' && typeof g.evidence.text === 'string') {
        g.evidence = { ...g.evidence, text: scrubText(g.evidence.text, ctx, 200) };
      }
      return g;
    });
  }
  if (Array.isArray(out.warnings)) {
    out.warnings = out.warnings.map((/** @type {any} */ w) => (w && typeof w.text === 'string' ? { ...w, text: scrubText(w.text, ctx, 160) } : w));
  }
  return out;
}
