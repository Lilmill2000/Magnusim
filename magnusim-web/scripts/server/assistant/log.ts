/**
 * The Assistant's log lines: `[assistant] message {fields}`, always passed through
 * redact(), and capped. Callers log codes, ids, counts and timings, never a prompt, a
 * tool result or a key.
 */
import { redact } from './redact.ts';

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_LINE = 2000;

export function alog(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  let line = `[assistant] ${msg}`;
  if (fields && Object.keys(fields).length) {
    try {
      line += ` ${JSON.stringify(fields)}`;
    } catch {
      line += ' {unprintable fields}';
    }
  }
  line = redact(line);
  if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
