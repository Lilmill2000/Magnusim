// @ts-check
/**
 * Structured JSONL job logger → .cache/logs/<kind>/<jobId>.jsonl
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');

export function createJobLogger(kind, jobId) {
  const safeKind = String(kind || 'job').replace(/[^\w.-]+/g, '_');
  const safeId = String(jobId || 'unknown').replace(/[^\w.-]+/g, '_');
  const dir = join(WEB_ROOT, '.cache', 'logs', safeKind);
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${safeId}.jsonl`);

  function write(level, msg, fields = {}) {
    const row = {
      ts: new Date().toISOString(),
      kind: safeKind,
      job_id: safeId,
      level,
      msg: String(msg || ''),
      ...fields,
    };
    try {
      appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8');
    } catch {
      /* ignore disk errors */
    }
    if (level === 'warn' || level === 'error') {
      const line = `[${safeKind}/${safeId}] ${msg}`;
      if (level === 'error') console.error(line);
      else console.warn(line);
    }
  }

  return {
    path: logPath,
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
