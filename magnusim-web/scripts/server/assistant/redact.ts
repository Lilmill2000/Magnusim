/**
 * Scrubs secrets out of text that leaves the Assistant: log lines (log.ts) and the error
 * text of every Assistant route (assistant-routes.ts). It removes each provider key this
 * server has saved or decrypted (registerSecretForRedaction), and anything shaped like a
 * provider key or a bearer token.
 */
import { assistantState } from './state.ts';

const MASK = '[redacted]';
/** Shorter values are not worth hiding, and would garble every message they appear in. */
const MIN_SECRET = 6;
const MAX_SECRETS = 64;

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[\w-]{8,}/g, MASK],
  [/sk-[\w-]{16,}/g, MASK],
  [/Bearer\s+\S{12,}/gi, `Bearer ${MASK}`],
];

/**
 * Every later redact() also removes `value` (and its JSON- and URL-escaped forms). Past
 * MAX_SECRETS, the secret registered (or used) longest ago is forgotten first.
 */
export function registerSecretForRedaction(value: string): void {
  const v = String(value || '');
  if (v.length < MIN_SECRET) return;
  const list = assistantState().redactions;
  const at = list.findIndex((forms) => forms[0] === v);
  if (at >= 0) list.splice(at, 1);
  list.push([...new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])]);
  while (list.length > MAX_SECRETS) list.shift();
}

export function redact(text: unknown): string {
  let out = typeof text === 'string' ? text : String(text ?? '');
  // Longest first, so a key that contains another is removed whole.
  const secrets = assistantState().redactions.flat().sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  for (const [re, mask] of PATTERNS) out = out.replace(re, mask);
  return out;
}
