/**
 * Untrusted text and data on their way to the model (Foundation spec 6.8).
 *
 * Tool results, workspace descriptions and anything a plugin or a project file supplies
 * are data, never instructions: they reach the model only inside a tool result, as JSON
 * text, cleaned and capped here.
 *
 * - cleanText: no C0/C1 controls, DEL, line or paragraph separators, or bidi controls
 *   (the same set as the bridge's DIRTY_MESSAGE_CONTROLS, src/workspace/bridge.ts), one
 *   space between words, capped (names 200, descriptions 1024, other text 2000).
 * - sanitizeJson: plain JSON only, depth ≤ 8, ≤ 200 keys per object, ≤ 200 items per
 *   list, ≤ 32 KB in all; anything cut is marked `truncated`.
 * - checkImage: PNG, JPEG or WebP by their first bytes, ≤ 1.5 MB, ≤ 2000 px a side.
 */
import type { ImagePart, ToolResultPart } from './types.ts';

const CONTROLS = /[\p{Cc}\u{2028}\u{2029}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
const HAS_CONTROL = new RegExp(CONTROLS.source, 'u');

/** Whether `text` holds a character cleanText would take out (for values that must stay exact). */
export function hasControls(text: string): boolean {
  return HAS_CONTROL.test(text);
}

export const TEXT_CAPS = Object.freeze({ name: 200, description: 1024, other: 2000 });
export const JSON_CAPS = Object.freeze({ depth: 8, keys: 200, items: 200, bytes: 32 * 1024 });
export const IMAGE_CAPS = Object.freeze({ perResult: 4, bytes: 1.5 * 1024 * 1024, side: 2000 });

/** Cut to `max` characters without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Text as the model may see it: no controls, single spaces, at most `max` characters. */
export function cleanText(raw: unknown, max: number = TEXT_CAPS.other): string {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return cut(text.replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim(), max);
}

interface Budget {
  left: number;
  truncated: boolean;
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Spends `cost` (a JSON fragment or a byte count) if it fits. */
function take(b: Budget, cost: string | number): boolean {
  const n = typeof cost === 'string' ? bytes(cost) : cost;
  if (n > b.left) {
    b.truncated = true;
    return false;
  }
  b.left -= n;
  return true;
}

/** The longest start of `s` whose JSON form fits in `room` bytes. */
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

/** `v` as cleaned JSON within the budget; undefined when not even its smallest form fits. */
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

/** `value` as plain, cleaned, capped JSON data (at most `maxBytes` as JSON). */
export function sanitizeJson(value: unknown, maxBytes: number = JSON_CAPS.bytes): { value: unknown; truncated: boolean } {
  const b: Budget = { left: maxBytes, truncated: false };
  const out = clean(value, 0, b);
  return { value: out === undefined ? null : out, truncated: b.truncated };
}

export interface ResultBody {
  ok: boolean;
  data?: unknown;
  text?: string;
  error?: { code: string; message: string; hint?: string };
}

/** At most this much of a result's free text. */
const RESULT_TEXT_BYTES = 16 * 1024;

/**
 * The text a tool result reaches the model as: `{"tool","ok","data","text"}` or
 * `{"tool","ok":false,"error":{…}}`, cleaned, ≤ 32 KB, `"truncated": true` when cut.
 */
export function resultText(tool: string, r: ResultBody): string {
  const name = cleanText(tool, TEXT_CAPS.name);
  if (!r.ok) {
    const e = r.error ?? { code: 'failed', message: 'The tool failed.' };
    const error = {
      code: cleanText(e.code, 64) || 'failed',
      message: cleanText(e.message, TEXT_CAPS.other),
      ...(e.hint ? { hint: cleanText(e.hint, TEXT_CAPS.other) } : {}),
    };
    return JSON.stringify({ tool: name, ok: false, error });
  }
  let cutText = false;
  let text: string | undefined;
  if (r.text !== undefined) {
    const full = cleanText(r.text, Number.MAX_SAFE_INTEGER);
    text = fitString(full, RESULT_TEXT_BYTES);
    cutText = text.length !== full.length;
  }
  const out: Record<string, unknown> = { tool: name, ok: true };
  if (r.data !== undefined) {
    // What the result takes besides its data, counted as if it were cut: the rest is the data's.
    const shell = JSON.stringify({ tool: name, ok: true, data: null, ...(text !== undefined ? { text } : {}), truncated: true });
    const data = sanitizeJson(r.data, JSON_CAPS.bytes - (bytes(shell) - 4));
    out.data = data.value;
    cutText ||= data.truncated;
  }
  if (text !== undefined) out.text = text;
  if (cutText) out.truncated = true;
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- images

export type ImageCheck =
  | { ok: true; mediaType: ImagePart['mediaType']; width: number; height: number }
  | { ok: false; error: string };

function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24 || b.readUInt32BE(12) !== 0x49484452) return null; // IHDR
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, but not DHT (C4), JPG (C8) or DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

/** Whether `bytes` are an image the model may be sent, and what kind and size. */
export function checkImage(bytes: Buffer | Uint8Array): ImageCheck {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > IMAGE_CAPS.bytes) return { ok: false, error: `The image is larger than ${IMAGE_CAPS.bytes / (1024 * 1024)} MB.` };
  let mediaType: ImagePart['mediaType'] | null = null;
  let size: { width: number; height: number } | null = null;
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    mediaType = 'image/png';
    size = pngSize(b);
  } else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    mediaType = 'image/jpeg';
    size = jpegSize(b);
  } else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    mediaType = 'image/webp';
    size = webpSize(b);
  }
  if (!mediaType) return { ok: false, error: 'Only PNG, JPEG and WebP images can be sent.' };
  if (!size || !size.width || !size.height) return { ok: false, error: 'The image could not be read.' };
  if (size.width > IMAGE_CAPS.side || size.height > IMAGE_CAPS.side) {
    return { ok: false, error: `The image is ${size.width}×${size.height} px; at most ${IMAGE_CAPS.side} px a side can be sent.` };
  }
  return { ok: true, mediaType, ...size };
}

/** A tool result part for the next user message (text as resultText, images already checked). */
export function capResult(callId: string, tool: string, r: ResultBody, images: ImagePart[] = []): ToolResultPart {
  return { type: 'tool_result', callId, isError: !r.ok, text: resultText(tool, r), images: images.slice(0, IMAGE_CAPS.perResult) };
}
