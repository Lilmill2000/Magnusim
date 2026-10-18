// A copy of the app's rules for a tool result on its way to the model
// (scripts/server/assistant/sanitize.ts cleanText, sanitizeJson and resultText's ok branch), for
// checking what the Part's fixed replies (help) become there: no controls and one space between
// words in every string, at most 2000 characters a string, a container at depth 8 of the reply
// becomes null, at most 200 keys an object and 200 items a list, at most 32 KB in all, and
// `truncated` when anything was cut. The CAD plugin cannot import the app's server code, so this
// copy follows it line for line; the app's host test (scripts/__tests__/assistant-cad-tools.test.mjs)
// fails when its caps or its answers differ from the server's.
// SPDX-License-Identifier: GPL-3.0-or-later

const CONTROLS = /[\p{Cc}\u{2028}\u{2029}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
export const TEXT_CAPS = Object.freeze({ name: 200, description: 1024, other: 2000 });
export const JSON_CAPS = Object.freeze({ depth: 8, keys: 200, items: 200, bytes: 32 * 1024 });

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

export function cleanText(raw: unknown, max: number = TEXT_CAPS.other): string {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return cut(text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim(), max);
}

interface Budget {
  left: number;
  truncated: boolean;
}

function take(b: Budget, cost: string | number): boolean {
  const n = typeof cost === 'string' ? bytes(cost) : cost;
  if (n > b.left) {
    b.truncated = true;
    return false;
  }
  b.left -= n;
  return true;
}

function fitString(s: string, room: number): string {
  if (bytes(JSON.stringify(s)) <= room) return s;
  const chars = [...s];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(JSON.stringify(chars.slice(0, mid).join(''))) <= room) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}

function clean(v: unknown, depth: number, b: Budget): unknown {
  if (v === null || typeof v === 'boolean') return take(b, JSON.stringify(v)) ? v : undefined;
  if (typeof v === 'number') {
    const n = Number.isFinite(v) ? v : null;
    return take(b, JSON.stringify(n)) ? n : undefined;
  }
  if (typeof v === 'string') {
    const full = cleanText(v, Number.MAX_SAFE_INTEGER);
    let s = cut(full, TEXT_CAPS.other);
    if (s.length !== full.length) b.truncated = true;
    if (b.left < 2) {
      b.truncated = true;
      return undefined;
    }
    const fitted = fitString(s, b.left);
    if (fitted.length !== s.length) b.truncated = true;
    s = fitted;
    take(b, JSON.stringify(s));
    return s;
  }
  if (typeof v !== 'object' || v === undefined) return take(b, 'null') ? null : undefined;
  if (depth >= JSON_CAPS.depth) {
    b.truncated = true;
    return take(b, 'null') ? null : undefined;
  }
  if (Array.isArray(v)) {
    if (!take(b, '[]')) return undefined;
    const out: unknown[] = [];
    if (v.length > JSON_CAPS.items) b.truncated = true;
    for (const item of v.slice(0, JSON_CAPS.items)) {
      const comma = out.length ? 1 : 0;
      if (!take(b, comma)) break;
      const c = clean(item === undefined || typeof item === 'function' ? null : item, depth + 1, b);
      if (c === undefined) {
        b.left += comma;
        b.truncated = true;
        break;
      }
      out.push(c);
    }
    return out;
  }
  if (!take(b, '{}')) return undefined;
  const out: Record<string, unknown> = {};
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && typeof x !== 'function');
  if (entries.length > JSON_CAPS.keys) b.truncated = true;
  let n = 0;
  for (const [k, x] of entries.slice(0, JSON_CAPS.keys)) {
    const key = cleanText(k, TEXT_CAPS.name);
    const cost = bytes(JSON.stringify(key)) + 1 + (n ? 1 : 0);
    if (!take(b, cost)) break;
    const c = clean(x, depth + 1, b);
    if (c === undefined) {
      b.left += cost;
      b.truncated = true;
      break;
    }
    Object.defineProperty(out, key, { value: c, enumerable: true, writable: true, configurable: true });
    n += 1;
  }
  return out;
}

export function sanitizeJson(value: unknown, maxBytes: number = JSON_CAPS.bytes): { value: unknown; truncated: boolean } {
  const b: Budget = { left: maxBytes, truncated: false };
  const out = clean(value, 0, b);
  return { value: out === undefined ? null : out, truncated: b.truncated };
}

const RESULT_TEXT_BYTES = 16 * 1024;

/** An ok result as the model reads it: {tool, ok, data, text, truncated?}, parsed back. */
export function resultAsSent(tool: string, r: { data?: unknown; text?: string }): { tool: string; ok: true; data?: unknown; text?: string; truncated?: true } {
  const name = cleanText(tool, TEXT_CAPS.name);
  let cutText = false;
  let text: string | undefined;
  if (r.text !== undefined) {
    const full = cleanText(r.text, Number.MAX_SAFE_INTEGER);
    text = fitString(full, RESULT_TEXT_BYTES);
    cutText = text.length !== full.length;
  }
  const out: Record<string, unknown> = { tool: name, ok: true };
  if (r.data !== undefined) {
    const shell = JSON.stringify({ tool: name, ok: true, data: null, ...(text !== undefined ? { text } : {}), truncated: true });
    const data = sanitizeJson(r.data, JSON_CAPS.bytes - (bytes(shell) - 4));
    out.data = data.value;
    cutText ||= data.truncated;
  }
  if (text !== undefined) out.text = text;
  if (cutText) out.truncated = true;
  return JSON.parse(JSON.stringify(out));
}
