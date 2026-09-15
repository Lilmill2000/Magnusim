// @ts-check
/**
 * Thin JSONL job adapter (Phase 1 Step 7 partial).
 *
 * Spawns a Python tool (prepare_run / run_solve / generate_*), splits stdout by
 * line, parses MAGNUSIM_EVENT / CFDDESK_EVENT alias (and bare {"event":...}) JSON, writes structured
 * rows via log.js, and invokes onEvent.
 *
 * w27 startSolve uses this for run_solve JSONL; w21 parseCfmeshLine still separate — that is
 * the next land once run_solve is proven end-to-end from startSolve.
 */
import { spawn } from 'node:child_process';
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
 * @param {{
 *   kind: string,
 *   jobId: string,
 *   script: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   onEvent?: (ev: object) => void,
 *   onExit?: (code: number|null, signal: NodeJS.Signals|null) => void,
 *   python?: string,
 * }} opts
 */
export function spawnJob(opts) {
  const kind = opts.kind || 'job';
  const jobId = opts.jobId || 'unknown';
  const script = opts.script;
  const args = Array.isArray(opts.args) ? opts.args : [];
  const python = opts.python || PYTHON;
  const jobLog = createJobLogger(kind, jobId);
  const child = spawn(python, [script, ...args], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env || {}) },
  });
  jobLog.info('spawn', { pid: child.pid || null, script, args });

  let buf = '';
  /** @param {Buffer|string} chunk */
  const onChunk = (chunk) => {
    buf += chunk.toString('utf8');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || '';
    for (const line of parts) {
      const ev = parseJobLine(line);
      if (ev) {
        try {
          jobLog.info(ev.event || 'event', ev);
        } catch {}
        if (typeof opts.onEvent === 'function') {
          try {
            opts.onEvent(ev);
          } catch {}
        }
      } else if (line.trim()) {
        try {
          jobLog.info('stdout', { line: line.slice(0, 500) });
        } catch {}
      }
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);

  child.on('error', (err) => {
    jobLog.error('spawn_error', { error: String(err) });
    if (typeof opts.onExit === 'function') opts.onExit(-1, null);
  });
  child.on('exit', (code, signal) => {
    if (buf.trim()) onChunk('\n');
    jobLog.info('exit', { code, signal });
    if (typeof opts.onExit === 'function') opts.onExit(code, signal);
  });

  return { child, jobLog, parseJobLine };
}

export default { spawnJob, parseJobLine };
