// @ts-check
/**
 * Structured JSONL job logger → .cache/logs/<kind>/<jobId>.jsonl
 *
 * Rows are queued and appended in batches (one append every FLUSH_MS, or at once
 * when FLUSH_BYTES are waiting), never one file write per row: a job that sends
 * thousands of events a second kept the server from answering while it ran.
 * Loggers of one file share one queue, so rows keep the order they were written
 * in. `flush()` writes the queue now (spawnJob calls it before its exit
 * callbacks, so code that reads the log right after a job ends sees every row),
 * and every queue is written when the process exits.
 *
 * A file takes at most MAX_LOG_BYTES (or `maxBytes`) per server run: then one
 * `log_capped` row says so, and only warnings, errors and the job's end rows
 * (exit, close) are written after it, up to END_RESERVE_BYTES more.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');

export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const END_RESERVE_BYTES = 256 * 1024;
const FLUSH_MS = 100;
const FLUSH_BYTES = 256 * 1024;
const END_ROWS = new Set(['exit', 'close', 'spawn_error']);
const IDLE_QUEUES_KEPT = 200;

/**
 * @typedef {{ path: string, rows: string[], waiting: number, bytes: number, max: number,
 *   capped: boolean, dropped: number, timer: ReturnType<typeof setTimeout> | null, used: number }} Queue
 */

/** One queue per file. @type {Map<string, Queue>} */
const queues = new Map();
/** Queues with rows not written yet. @type {Set<Queue>} */
const waiting = new Set();
let exitHooked = false;

/** @param {Queue} q */
function flushQueue(q) {
  if (q.timer) clearTimeout(q.timer);
  q.timer = null;
  waiting.delete(q);
  if (!q.rows.length) return;
  const text = q.rows.join('');
  q.rows = [];
  q.waiting = 0;
  try {
    appendFileSync(q.path, text, 'utf8');
  } catch {
    // A batch is many rows: once more, its folder made again (a cleanup may have removed it).
    try {
      mkdirSync(dirname(q.path), { recursive: true });
      appendFileSync(q.path, text, 'utf8');
    } catch {
      /* ignore disk errors */
    }
  }
}

/** Write every queued row now (all job logs). */
export function flushJobLogs() {
  for (const q of [...waiting]) flushQueue(q);
}

/**
 * @param {string} path
 * @param {number} max
 * @returns {Queue}
 */
function queueFor(path, max) {
  let q = queues.get(path);
  if (!q) {
    if (queues.size >= IDLE_QUEUES_KEPT * 2) {
      // Forget the oldest idle ones (a later logger of such a file starts a new count).
      const idle = [...queues.values()].filter((x) => !x.rows.length).sort((a, b) => a.used - b.used);
      for (const x of idle.slice(0, idle.length - IDLE_QUEUES_KEPT)) queues.delete(x.path);
    }
    q = { path, rows: [], waiting: 0, bytes: 0, max, capped: false, dropped: 0, timer: null, used: Date.now() };
    queues.set(path, q);
  }
  return q;
}

/**
 * @param {string} kind
 * @param {string} jobId
 * @param {{ maxBytes?: number }} [opts]
 */
export function createJobLogger(kind, jobId, opts = {}) {
  const safeKind = String(kind || 'job').replace(/[^\w.-]+/g, '_');
  const safeId = String(jobId || 'unknown').replace(/[^\w.-]+/g, '_');
  const dir = join(WEB_ROOT, '.cache', 'logs', safeKind);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${safeId}.jsonl`);
  const max = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_LOG_BYTES;

  /**
   * @param {Queue} q
   * @param {string} text
   * @param {number} [size]
   */
  function push(q, text, size = Buffer.byteLength(text)) {
    q.rows.push(text);
    q.bytes += size;
    q.waiting += size;
    waiting.add(q);
    if (!exitHooked) {
      exitHooked = true;
      process.on('exit', flushJobLogs);
    }
    if (q.waiting >= FLUSH_BYTES) flushQueue(q);
    else if (!q.timer) {
      q.timer = setTimeout(() => flushQueue(q), FLUSH_MS);
      if (typeof q.timer.unref === 'function') q.timer.unref();
    }
  }

  /**
   * @param {string} level
   * @param {unknown} msg
   * @param {Record<string, unknown>} [fields]
   */
  function write(level, msg, fields = {}) {
    const q = queueFor(logPath, max);
    q.used = Date.now();
    const name = String(msg || '');
    const ts = new Date().toISOString();
    /** @type {Record<string, unknown>} */
    const row = { ts, kind: safeKind, job_id: safeId, level, msg: name, ...fields };
    const endRow = level !== 'info' || END_ROWS.has(name);
    if (q.capped && endRow && q.dropped) row.dropped_rows = q.dropped;
    let text;
    try {
      text = JSON.stringify(row) + '\n';
    } catch {
      return;
    }
    const size = Buffer.byteLength(text);
    if (q.bytes + size > q.max) {
      if (!q.capped) {
        q.capped = true;
        push(q, JSON.stringify({ ts, kind: safeKind, job_id: safeId, level: 'warn', msg: 'log_capped', max_bytes: q.max }) + '\n');
      }
      if (!endRow || q.bytes + size > q.max + END_RESERVE_BYTES) {
        q.dropped += 1;
        return;
      }
    }
    push(q, text, size);
    if (level === 'warn' || level === 'error') {
      const line = `[${safeKind}/${safeId}] ${name}`;
      if (level === 'error') console.error(line);
      else console.warn(line);
    }
  }

  return {
    path: logPath,
    /** @param {unknown} msg @param {Record<string, unknown>} [fields] */
    info: (msg, fields) => write('info', msg, fields),
    /** @param {unknown} msg @param {Record<string, unknown>} [fields] */
    warn: (msg, fields) => write('warn', msg, fields),
    /** @param {unknown} msg @param {Record<string, unknown>} [fields] */
    error: (msg, fields) => write('error', msg, fields),
    /** Write this file's queued rows now. */
    flush: () => {
      const q = queues.get(logPath);
      if (q) flushQueue(q);
    },
  };
}
