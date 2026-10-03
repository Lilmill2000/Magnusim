// @ts-check
/**
 * Thin JSONL job adapter (Phase 1 Step 7 partial).
 *
 * Spawns a Python tool (the step-list runner's relay, generate_*, ...), splits stdout by
 * line, parses MAGNUSIM_EVENT / CFDDESK_EVENT alias (and bare {"event":...}) JSON, writes structured
 * rows via log.js (a thinned copy for a fast job: createLogThinner), and invokes onEvent.
 *
 * Core solves and plugin OpenFOAM cases reach it through foam-runner.js; w21 parseCfmeshLine is
 * still separate.
 */
import { spawn } from 'node:child_process';
import { isolatedPythonEnv, ownProcessGroup } from './proc-tree.js';
import { createJobLogger } from './log.js';
import { PYTHON } from './python-env.js';

const EVENT_PREFIX = 'MAGNUSIM_EVENT ';
const EVENT_PREFIX_ALIASES = ['MAGNUSIM_EVENT ', 'CFDDESK_EVENT '];

/**
 * @param {string} line
 * @returns {object|null}
 */
export function parseJobLine(line) {
  let raw = String(line || '').trim();
  if (!raw) return null;
  // optional MPI rank prefix
  if (raw.startsWith('[') && raw.indexOf(']') > 0 && raw.indexOf(']') < 8) {
    raw = raw.slice(raw.indexOf(']') + 1).trim();
  }
  let payload = null;
  for (const prefix of EVENT_PREFIX_ALIASES) {
    if (raw.startsWith(prefix)) {
      payload = raw.slice(prefix.length).trim();
      break;
    }
  }
  if (payload == null && raw.startsWith('{') && raw.includes('"event"')) payload = raw;
  if (!payload) return null;
  try {
    const data = JSON.parse(payload);
    if (!data || typeof data !== 'object' || !data.event) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Which of a job's output goes to its log file. Every event still reaches
 * onEvent; this only keeps a fast job's file small (a solver sends about ten
 * events a time step, and a small case thousands of steps a second).
 *
 * - Time steps (a `progress` event, the `courant` events before it and the
 *   `residual` events after it): every step until `stepRowsFull` of their rows
 *   are written; then one step in 2, the stride doubling every `stepRowsOctave`
 *   more rows. A written step's progress row carries `thinned`, the steps left
 *   out right before it, so parseSolveProgress (w27-solve.js) still counts every
 *   step and spaces the residual points by step. A left-out step is held until
 *   the next one starts: when anything else comes first (a stage, a saved time,
 *   the end), it is written before that, so the last step, and the step before
 *   every other event, are always in the file.
 * - Output lines (`log` events, plain lines): the first `linesFull`, then one in
 *   `linesEvery`; a left-out step's are left out with it. The end of the output
 *   is where an error is, so the last lines are kept whole: the last
 *   `tailLines` after the last other row, and a held step's newest `heldMax`.
 *   Plain stderr lines (a traceback) are no step's: they wait in their own tail
 *   (the last `tailLines` of them, written whole at the end), as they may be
 *   read before the end of stdout.
 * - Every other event: always.
 *
 * Rows keep their order (stderr's among themselves: past `linesFull` they come
 * after the stdout rows read with them). `event` and `line` give the rows to write now, `end`
 * the held ones (at the end of the output), `stats` what was left out (null when
 * nothing was).
 * @param {{ stepRowsFull?: number, stepRowsOctave?: number, linesFull?: number, linesEvery?: number, heldMax?: number, tailLines?: number }} [opts]
 */
export function createLogThinner(opts = {}) {
  const stepRowsFull = opts.stepRowsFull ?? 40_000;
  const stepRowsOctave = opts.stepRowsOctave ?? 20_000;
  const linesFull = opts.linesFull ?? 10_000;
  const linesEvery = opts.linesEvery ?? 100;
  const heldMax = opts.heldMax ?? 256;
  const tailLines = opts.tailLines ?? 256;
  let steps = 0;
  let stepsWritten = 0;
  let stepRows = 0;
  let skipped = 0;
  let lines = 0;
  let linesWritten = 0;
  /** The current step was left out: its rows wait in `held`. */
  let dropped = false;
  /** @typedef {{ msg: string, fields: Record<string, any>, step?: boolean, progress?: boolean, n?: number, err?: boolean }} Row */
  /** @type {Row[]} */
  let held = [];
  let heldLines = 0;
  /** Rows from a `courant` event on: they go with the next step. @type {Row[]} */
  let lead = [];
  let leadLines = 0;
  /** Lines past `linesFull` since the last other row: thinned when a row follows, whole at the end. @type {Row[]} */
  let tail = [];
  /** Stderr's lines past `linesFull`: thinned as they leave it, whole at the end. @type {Row[]} */
  let errTail = [];
  /** @type {Array<[string, Record<string, any>]>} */
  let out = [];

  /** @param {Row} r */
  const writeLine = (r) => {
    linesWritten += 1;
    out.push([r.msg, r.fields]);
  };
  /** The waiting lines, before a later row: one in `linesEvery`, or (`all`, the end) every one. */
  const drainTail = (all = false) => {
    for (const r of tail) if (all || (r.n || 0) % linesEvery === 0) writeLine(r);
    tail = [];
  };
  /** @param {Row} row */
  const emit = (row) => {
    if (row.n) {
      if (linesWritten < linesFull) writeLine(row);
      else {
        const waits = row.err ? errTail : tail;
        waits.push(row);
        const first = waits.length > tailLines ? waits.shift() : null;
        if (first && (first.n || 0) % linesEvery === 0) writeLine(first);
      }
      return;
    }
    drainTail();
    if (row.step) stepRows += 1;
    let fields = row.fields;
    if (row.progress) {
      stepsWritten += 1;
      if (skipped) fields = { ...fields, thinned: skipped };
      skipped = 0;
    }
    out.push([row.msg, fields]);
  };
  /** Write the held step and what waits for the next one. */
  const release = () => {
    const rows = [...held, ...lead];
    held = [];
    lead = [];
    heldLines = 0;
    leadLines = 0;
    dropped = false;
    for (const r of rows) emit(r);
  };
  /**
   * An output line into a step's waiting rows that hold `count` lines: past
   * `heldMax` the oldest line goes (the newest are where an error is).
   * @param {Row[]} rows @param {Row} r @param {number} count
   */
  const keepLine = (rows, r, count) => {
    if (count >= heldMax) rows.splice(rows.findIndex((x) => x.n), 1);
    rows.push(r);
    return Math.min(count + 1, heldMax);
  };
  /** Output lines take at most `heldMax` places, so a step's own rows always fit. @param {Row} r */
  const hold = (r) => {
    if (r.n) heldLines = keepLine(held, r, heldLines);
    else if (held.length - heldLines < heldMax * 16) held.push(r);
  };
  /** @param {Row} r */
  const addLine = (r) => {
    lines += 1;
    r.n = lines;
    if (r.err) emit(r);
    else if (lead.length) leadLines = keepLine(lead, r, leadLines);
    else if (dropped) hold(r);
    else emit(r);
  };
  const take = () => {
    const rows = out;
    out = [];
    return rows;
  };

  return {
    /** @param {Record<string, any>} ev */
    event(ev) {
      const kind = ev.event;
      /** @type {Row} */
      const row = { msg: String(kind || 'event'), fields: ev };
      if (kind === 'progress') {
        steps += 1;
        if (dropped) skipped += 1;
        held = [];
        heldLines = 0;
        const stride = stepRows < stepRowsFull ? 1 : 2 ** (1 + Math.floor((stepRows - stepRowsFull) / stepRowsOctave));
        const waiting = lead;
        lead = [];
        leadLines = 0;
        row.step = true;
        row.progress = true;
        dropped = steps % stride !== 0;
        if (dropped) {
          for (const r of waiting) hold(r);
          hold(row);
        } else {
          for (const r of waiting) emit(r);
          emit(row);
        }
      } else if (kind === 'courant') {
        row.step = true;
        if (lead.length - leadLines < heldMax) lead.push(row);
      } else if (kind === 'residual') {
        row.step = true;
        const waiting = lead;
        lead = [];
        leadLines = 0;
        if (dropped) {
          for (const r of waiting) hold(r);
          hold(row);
        } else {
          for (const r of waiting) emit(r);
          emit(row);
        }
      } else if (kind === 'log') {
        addLine(row);
      } else {
        release();
        emit(row);
      }
      return take();
    },
    /** A plain output line (of stderr: `stream` 'stderr'). @param {string} text @param {string} [stream] */
    line(text, stream = 'stdout') {
      addLine({ msg: 'stdout', fields: { line: text.slice(0, 500) }, err: stream === 'stderr' });
      return take();
    },
    end() {
      release();
      drainTail(true);
      for (const r of errTail) writeLine(r);
      errTail = [];
      return take();
    },
    stats() {
      if (stepsWritten === steps && linesWritten === lines) return null;
      return { steps, steps_written: stepsWritten, lines, lines_written: linesWritten };
    },
  };
}

/**
 * @param {{
 *   kind: string,
 *   jobId: string,
 *   script: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   onEvent?: (ev: object) => void,
 *   onExit?: (code: number|null, signal: NodeJS.Signals|null) => void,
 *   onClose?: () => void,
 *   python?: string,
 *   cwd?: string,
 * }} opts
 *
 * stdout and stderr keep their own line buffers. With `onClose`, called once
 * every stdio pipe has closed (a starter whose child keeps its pipes closes only
 * when that child ends), both are flushed at close, not at exit. `onExit` still
 * comes at exit (and with -1 for a spawn error). Without it, a part line is
 * flushed at exit, and output read after the exit when its stream ends.
 */
export function spawnJob(opts) {
  const kind = opts.kind || 'job';
  const jobId = opts.jobId || 'unknown';
  const script = opts.script;
  const args = Array.isArray(opts.args) ? opts.args : [];
  const python = opts.python || PYTHON;
  const jobLog = createJobLogger(kind, jobId);
  const base = { ...process.env, ...(opts.env || {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  const child = spawn(python, [script, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Another interpreter (a plugin's own environment) sees nothing of the core's.
    env: opts.python && opts.python !== PYTHON ? isolatedPythonEnv(base) : base,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    // Stop ends what the tool started too (POSIX: its own process group).
    ...ownProcessGroup(),
  });
  jobLog.info('spawn', { pid: child.pid || null, script, args });

  // The log file gets a thinned copy of the output; onEvent gets every event.
  const thin = createLogThinner();
  /** @param {Array<[string, Record<string, any>]>} rows */
  const writeRows = (rows) => {
    for (const [msg, fields] of rows) {
      try {
        jobLog.info(msg, fields);
      } catch {}
    }
  };
  /**
   * The end of the output (exit, close): the held rows, this row, then the file
   * is written, before the callbacks run.
   * @param {string} msg
   * @param {Record<string, any>} fields
   */
  const endLog = (msg, fields) => {
    writeRows(thin.end());
    const stats = thin.stats();
    try {
      jobLog.info(msg, stats ? { ...fields, log_thinned: stats } : fields);
    } catch {}
    jobLog.flush();
  };

  /** @param {string} line @param {string} stream */
  const onLine = (line, stream) => {
    const ev = parseJobLine(line);
    if (ev) {
      writeRows(thin.event(ev));
      if (typeof opts.onEvent === 'function') {
        try {
          opts.onEvent(ev);
        } catch {}
      }
    } else if (line.trim()) {
      writeRows(thin.line(line, stream));
    }
  };
  const withClose = typeof opts.onClose === 'function';
  /** One line buffer per stream (the log keeps a tool's stderr tail apart). @param {string} stream */
  const lineReader = (stream) => {
    let pending = '';
    return {
      /** @param {Buffer|string} chunk */
      push(chunk) {
        pending += chunk.toString('utf8');
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() || '';
        for (const line of parts) onLine(line, stream);
      },
      flush() {
        const rest = pending;
        pending = '';
        if (rest.trim()) onLine(rest, stream);
      },
    };
  };
  const outReader = lineReader('stdout');
  const errReader = lineReader('stderr');
  child.stdout?.on('data', (chunk) => outReader.push(chunk));
  child.stderr?.on('data', (chunk) => errReader.push(chunk));

  child.on('error', (err) => {
    jobLog.error('spawn_error', { error: String(err) });
    jobLog.flush();
    if (typeof opts.onExit === 'function') {
      try {
        opts.onExit(-1, null);
      } catch (e) {
        console.error('[CFD] job onExit (spawn error)', e);
      }
    }
  });
  child.on('exit', (code, signal) => {
    if (!withClose) {
      outReader.flush();
      errReader.flush();
    }
    endLog('exit', { code, signal });
    if (typeof opts.onExit === 'function') {
      try {
        opts.onExit(code, signal);
      } catch (e) {
        console.error('[CFD] job onExit', e);
      }
    }
  });
  if (withClose) {
    child.on('close', () => {
      outReader.flush();
      errReader.flush();
      endLog('close', {});
      try {
        /** @type {() => void} */ (opts.onClose)();
      } catch (e) {
        console.error('[CFD] job onClose', e);
      }
    });
  } else {
    // Output read after the exit: written, with what it held, when its stream ends.
    for (const [stream, reader] of /** @type {const} */ ([
      [child.stdout, outReader],
      [child.stderr, errReader],
    ])) {
      stream?.once('end', () => {
        reader.flush();
        writeRows(thin.end());
        jobLog.flush();
      });
    }
  }

  return { child, jobLog, parseJobLine };
}

export default { spawnJob, parseJobLine };
