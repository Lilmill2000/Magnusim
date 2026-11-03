// @ts-check
/**
 * Run health's two read routes (RH1, spec 3.8 and 3.9), handled in w27-solve.js's handleW27Api:
 *
 * - GET /api/run/solver-log?project_id&simulation_id&run_id&lines=200&at=end|start|<log_at>&key=&filter=|issues
 *   The run's solver output, from the Windows copy of its log (never wsl.exe): its parts
 *   log.<app>.1, .2, ... (oldest first) then log.<app>, one positioned read of at most 64 KB.
 *   at=end reads the end of the newest part; at=start the start of the oldest; at=<log_at> from
 *   16 KB before that offset in the part that holds it, with `hit_line` the line that starts
 *   exactly there (else, nearest it, the one whose bytes hash to `key`, else the one whose
 *   scrubbed words are the finding's evidence words). Every line is scrubbed
 *   (solver-log-scrub.js). filter=issues keeps the limiter, bounding, iteration-cap, warning,
 *   fatal and nan lines and the Courant lines above the run's limit.
 * - GET /api/run/health?...&recompute=0|1: the run's health record. recompute=1 on an ended run
 *   that has none starts "Check its log" in the background (tools/log_health.py: the head of
 *   its oldest log part and the tail of its newest; never the worker's serial lane) and answers
 *   `checking: true`; the record lands in the run doc (healthPatch).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { corePythonPath } from './job-runner.js';
import { PYTHON, pyTool } from './python-env.js';
import { healthPatch, restartOf } from './run-health-shape.js';
import { logHostOf, scrubContext, scrubLine } from './solver-log-scrub.js';

export const SOLVER_LOG_READ_MAX = 64 * 1024;
export const SOLVER_LOG_BEFORE = 16 * 1024;
export const SOLVER_LOG_LINES_MAX = 200;
const APP_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const KEY_RE = /^[0-9a-f]{12}$/;

/** The run's solver (its app), as the runner, the fake solve or an old run doc names it. @param {any} doc */
export function runAppOf(doc) {
  const d = doc || {};
  const app = String(d.app || (d.launch && d.launch.app) || d.path_kind || '');
  return APP_RE.test(app) ? app : '';
}

/**
 * The run's log parts, oldest first: log.<app>.1, .2, ... then log.<app> (each `{name, path, size, base}`,
 * `base` its first byte's place in the whole log).
 * @param {string} caseDir
 * @param {string} app
 */
export function logParts(caseDir, app) {
  /** @type {Array<{ n: number, name: string }>} */
  const numbered = [];
  let names = [];
  try {
    names = readdirSync(caseDir);
  } catch {
    return [];
  }
  const re = new RegExp(`^log\\.${app}\\.(\\d+)$`);
  for (const name of names) {
    const m = re.exec(name);
    if (m) numbered.push({ n: Number(m[1]), name });
  }
  numbered.sort((a, b) => a.n - b.n);
  const list = numbered.map((x) => x.name);
  if (names.includes(`log.${app}`)) list.push(`log.${app}`);
  /** @type {Array<{ name: string, path: string, size: number, base: number, mtime: string }>} */
  const out = [];
  let base = 0;
  for (const name of list) {
    const path = join(caseDir, name);
    try {
      const st = statSync(path);
      out.push({ name, path, size: st.size, base, mtime: st.mtime.toISOString() });
      base += st.size;
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/**
 * One positioned read.
 * @param {string} path
 * @param {number} start
 * @param {number} length
 */
function readAt(path, start, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

/**
 * The lines of a read, each with its byte place in the part (`at`) and its raw bytes. A first
 * line cut by the read's start (it began before `start`) is left out, and so is a last line
 * cut by its end.
 * @param {Buffer} buf
 * @param {number} start
 * @param {boolean} fromLineStart
 * @param {boolean} toEnd the read reached the end of the part
 */
function splitLines(buf, start, fromLineStart, toEnd) {
  /** @type {Array<{ at: number, raw: Buffer }>} */
  const out = [];
  let i = 0;
  if (!fromLineStart) {
    const nl = buf.indexOf(10);
    if (nl < 0) return out;
    i = nl + 1;
  }
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) {
      if (toEnd) out.push({ at: start + i, raw: buf.subarray(i) });
      break;
    }
    out.push({ at: start + i, raw: buf.subarray(i, nl) });
    i = nl + 1;
  }
  return out;
}

/** @param {Buffer} raw */
const rawText = (raw) => raw.toString('utf8').replace(/\r$/, '');
/** @param {string} text */
const keyOf = (text) => createHash('sha1').update(Buffer.from(text, 'utf8')).digest('hex').slice(0, 12);

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const RE_LIMIT_HIT = /^limitVelocity \S+ Limited ([1-9]\d*) /;
const RE_BOUND = /^bounding \w+, min:/;
const RE_ITERS = /No Iterations (\d+)\s*$/;
const RE_WARN = /^--> FOAM Warning/;
const RE_FATAL = /^--> FOAM FATAL|Foam::sig(?:Fpe|Segv)::sigHandler|MPI_ABORT was invoked/;
const RE_NAN = /(?:=|:)\s*[-+]?(?:nan|inf)\b/i;
const RE_COURANT = new RegExp(`^Courant Number mean:\\s*${NUM}\\s+max:\\s*(${NUM})`);
const BENIGN = /allowSystemOperations/;

/**
 * Whether a solver line is a problem line (filter=issues).
 * @param {string} text the line without its MPI prefix
 * @param {{ maxCo: number | null, maxIter: number }} h
 */
export function isIssueLine(text, h) {
  const s = text.replace(/^\s*\[\d+\]\s*/, '');
  if (RE_FATAL.test(s)) return true;
  if (RE_WARN.test(s)) return !BENIGN.test(s);
  if (RE_LIMIT_HIT.test(s) || RE_BOUND.test(s)) return true;
  if (RE_NAN.test(s) && /residual|Courant|bounding|continuity| = /.test(s)) return true;
  const it = RE_ITERS.exec(s);
  if (it && /Solving for/.test(s) && Number(it[1]) >= h.maxIter) return true;
  const co = RE_COURANT.exec(s);
  if (co && h.maxCo !== null && Number(co[1]) > h.maxCo) return true;
  return false;
}

/** The run's health hints (its case's w27-case.json), or {}. @param {string} caseDir */
function hintsOf(caseDir) {
  try {
    const doc = JSON.parse(readFileSync(join(caseDir, 'w27-case.json'), 'utf8'));
    const h = doc && (doc.health_hints || (doc.prepare_report && doc.prepare_report.health_hints));
    return h && typeof h === 'object' ? h : {};
  } catch {
    return {};
  }
}

/**
 * The solver output a route answers (spec 3.8).
 * @param {any} doc the run doc
 * @param {{ lines?: unknown, at?: unknown, key?: unknown, filter?: unknown, ctx?: { hosts: string[], user: string } }} q
 */
export function solverLogExcerptAt(doc, q) {
  const caseDir = doc && doc.case_dir ? String(doc.case_dir) : '';
  const app = runAppOf(doc);
  const live = ['running', 'starting', 'queued'].includes(String((doc && doc.status) || ''));
  const want = Math.max(1, Math.min(SOLVER_LOG_LINES_MAX, Math.floor(Number(q.lines) || SOLVER_LOG_LINES_MAX)));
  const filter = String(q.filter || '') === 'issues' ? 'issues' : '';
  const parts = caseDir && app ? logParts(caseDir, app) : [];
  const empty = { lines: [], first_line: null, hit_line: null, total_lines: null, truncated: false, live, as_of: null, part: null, filter, at: String(q.at ?? 'end') };
  if (!parts.length) return { ...empty, missing: true };
  // The scrub takes the log's own host name (its first 4 KB) as well as this PC's.
  let head = '';
  try {
    head = readAt(parts[0].path, 0, 4096).toString('utf8');
  } catch {
    head = '';
  }
  const ctx = q.ctx || scrubContext({ logHost: logHostOf(head) });
  const hints = hintsOf(caseDir);
  const ls = (hints.linsolve && typeof hints.linsolve === 'object' ? Object.values(hints.linsolve) : []).map((/** @type {any} */ v) => Number(v && v.max_iter)).filter((n) => Number.isFinite(n) && n > 0);
  const issueCtx = { maxCo: Number.isFinite(Number(hints.max_co)) && hints.max_co !== null ? Number(hints.max_co) : null, maxIter: ls.length ? Math.min(...ls) : 1000 };
  const atRaw = String(q.at ?? 'end');
  const key = KEY_RE.test(String(q.key || '')) ? String(q.key) : '';
  /** @type {{ name: string, path: string, size: number, base: number, mtime: string }} */
  let part;
  let start;
  let length;
  let mode;
  /** @type {number | null} */
  let target = null;
  if (atRaw === 'start') {
    mode = 'start';
    part = parts[0];
    start = 0;
    length = Math.min(part.size, SOLVER_LOG_READ_MAX);
  } else if (/^\d+$/.test(atRaw)) {
    mode = 'at';
    target = Number(atRaw);
    part = parts.find((p) => target !== null && target >= p.base && target < p.base + p.size) || parts[parts.length - 1];
    const local = Math.max(0, Math.min(part.size, target - part.base));
    start = Math.max(0, local - SOLVER_LOG_BEFORE);
    length = Math.min(part.size - start, SOLVER_LOG_READ_MAX);
  } else {
    mode = 'end';
    part = parts[parts.length - 1];
    length = Math.min(part.size, SOLVER_LOG_READ_MAX);
    start = part.size - length;
  }
  let buf;
  try {
    buf = readAt(part.path, start, length);
  } catch {
    return { ...empty, missing: true };
  }
  const toEnd = start + buf.length >= part.size;
  const rows = splitLines(buf, start, start === 0, toEnd);
  // The hit: the line starting at log_at, else (an offset that drifted) by its key, then its words.
  let hit = -1;
  if (mode === 'at' && target !== null) {
    const local = target - part.base;
    hit = rows.findIndex((r) => r.at === local);
    if (hit < 0 && key) {
      let best = -1;
      let dist = Infinity;
      rows.forEach((r, i) => {
        if (keyOf(rawText(r.raw)) !== key) return;
        const d = Math.abs(r.at - local);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      hit = best;
    }
    if (hit < 0 && key) {
      const words = evidenceWordsOf(doc, key);
      if (words) hit = rows.findIndex((r) => scrubLine(rawText(r.raw), ctx, { keepHeader: true }) === words);
    }
  }
  // The lines to show, scrubbed (header lines dropped), with the hit's place among them.
  /** @type {Array<{ text: string, hit: boolean }>} */
  const shown = [];
  rows.forEach((r, i) => {
    const text = rawText(r.raw);
    if (filter === 'issues' && i !== hit && !isIssueLine(text, issueCtx)) return;
    const s = scrubLine(text, ctx);
    if (s === null) return;
    shown.push({ text: s, hit: i === hit });
  });
  let pick;
  if (mode === 'start') pick = shown.slice(0, want);
  else if (mode === 'end') pick = shown.slice(-want);
  else {
    const at = shown.findIndex((x) => x.hit);
    const from = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(want / 4), shown.length - want));
    pick = shown.slice(from, from + want);
  }
  const hitLine = pick.findIndex((x) => x.hit);
  return {
    lines: pick.map((x) => x.text),
    first_line: mode === 'start' ? 1 : null,
    hit_line: hitLine >= 0 ? hitLine : null,
    total_lines: null,
    truncated: mode === 'end' ? start > 0 || shown.length > pick.length : !toEnd || shown.length > pick.length,
    live,
    as_of: part.mtime,
    part: part.name,
    filter,
    at: mode === 'at' ? String(target) : mode,
  };
}

/** The evidence words of the finding whose line hashes to `key`, as the record keeps them, or ''. @param {any} doc @param {string} key */
function evidenceWordsOf(doc, key) {
  const h = doc && doc.health;
  const f = h && Array.isArray(h.findings) ? h.findings.find((/** @type {any} */ x) => x && x.evidence && x.evidence.key === key) : null;
  return f && typeof f.evidence.text === 'string' ? f.evidence.text : '';
}

// ---- the old-run check ----

/** @returns {Map<string, { started: number, error: string | null, done: boolean }>} */
function checks() {
  const k = Symbol.for('magnusim.runHealthChecks');
  const g = /** @type {any} */ (globalThis);
  if (!g[k]) g[k] = new Map();
  return g[k];
}

/** The old-run check of this run, while it runs or after it failed (null: none). @param {string} key */
export function healthCheckState(key) {
  return checks().get(key) || null;
}

export function resetHealthChecksForTests() {
  checks().clear();
}

/**
 * Start "Check its log" for an ended run with no health: tools/log_health.py in the background.
 * `onDone(health | null, error | null)` gets the record, checked and scrubbed (healthPatch).
 * @param {string} key the run's key (project|run)
 * @param {any} doc the run doc
 * @param {(health: any, error: string | null) => void} onDone
 * @param {{ latestSaved?: number | null }} [opts]
 * @returns {boolean} whether a check runs now (it was already running, or started)
 */
export function startHealthCheck(key, doc, onDone, opts = {}) {
  const now = checks().get(key);
  if (now && !now.done) return true;
  const caseDir = doc && doc.case_dir ? String(doc.case_dir) : '';
  const app = runAppOf(doc);
  if (!caseDir || !app || !existsSync(caseDir)) {
    checks().set(key, { started: Date.now(), error: 'Its solver log is gone, so its health cannot be checked.', done: true });
    onDone(null, 'Its solver log is gone, so its health cannot be checked.');
    return false;
  }
  const state = { started: Date.now(), error: /** @type {string | null} */ (null), done: false };
  checks().set(key, state);
  const args = [pyTool('log_health.py'), '--case', caseDir, '--app', app];
  if (doc.analysis_key) args.push('--analysis', String(doc.analysis_key));
  if (doc.launch && doc.launch.plugin) args.push('--plugin', String(doc.launch.plugin));
  else if (doc.plugin) args.push('--plugin', String(doc.plugin));
  if (opts.latestSaved !== null && opts.latestSaved !== undefined && Number.isFinite(Number(opts.latestSaved))) args.push('--latest-saved', String(opts.latestSaved));
  if (Array.isArray(doc.attempts) && doc.attempts.length && !existsSync(join(caseDir, `log.${app}.1`))) args.push('--head-missing');
  let out = '';
  /** @type {import('node:child_process').ChildProcess} */
  let child;
  const finish = (/** @type {any} */ health, /** @type {string | null} */ error) => {
    if (state.done) return;
    state.done = true;
    state.error = error;
    if (!error) checks().delete(key);
    try {
      onDone(health, error);
    } catch (e) {
      console.warn('[CFD run health] check', e);
    }
  };
  try {
    child = spawn(PYTHON, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONPATH: corePythonPath(process.env.PYTHONPATH) },
    });
  } catch {
    finish(null, 'Its log could not be checked.');
    return false;
  }
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* gone */
    }
    finish(null, 'Checking its log took too long.');
  }, 5 * 60_000);
  if (typeof timer.unref === 'function') timer.unref();
  if (child.stdout) child.stdout.on('data', (d) => (out += String(d)));
  child.on('error', () => finish(null, 'Its log could not be checked.'));
  // Tests: the answer comes this much later (MAGNUSIM_TEST_HEALTH_CHECK_HOLD_MS), as a long log's
  // would, so a run can be deleted or started over after its log was read and before it is kept.
  const hold = Number(process.env.MAGNUSIM_TEST_HEALTH_CHECK_HOLD_MS) || 0;
  const answer = (/** @type {any} */ health, /** @type {string | null} */ error) => {
    if (hold > 0) setTimeout(() => finish(health, error), hold);
    else finish(health, error);
  };
  child.on('close', () => {
    clearTimeout(timer);
    try {
      const last = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'null';
      const doc2 = JSON.parse(last);
      if (!doc2 || !doc2.ok) return answer(null, String((doc2 && doc2.error) || 'Its log could not be checked.').slice(0, 200));
      const health = healthPatch(null, doc2.health);
      if (!health) return answer(null, 'Its log could not be checked.');
      answer({ ...health, live: false, checked_from_log: true }, null);
    } catch {
      answer(null, 'Its log could not be checked.');
    }
  });
  return true;
}

/**
 * A run's health as the routes and the Run panel show it: its `restart` from its own latest
 * saved time (where Continue would go on from).
 * @param {any} health
 * @param {number | null | undefined} latestSaved
 */
export function healthForRead(health, latestSaved) {
  if (!health || typeof health !== 'object') return null;
  return { ...health, restart: restartOf(health, latestSaved) };
}
