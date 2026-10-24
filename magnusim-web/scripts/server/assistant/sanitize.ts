/**
 * Untrusted text and data on their way to the model (Foundation spec 6.8).
 *
 * Tool results, and anything a plugin or a project file supplies in them, are data, never
 * instructions: they reach the model only inside a tool result, as JSON text, cleaned and
 * capped here. A workspace's tool descriptions and its guide are the plugin's own text
 * (the tool definitions, the model's instructions), cleaned here too.
 *
 * - cleanText: no C0/C1 controls, DEL, line or paragraph separators, or bidi controls
 *   (the same set as the bridge's DIRTY_MESSAGE_CONTROLS, src/workspace/bridge.ts), one
 *   space between words, capped (names 200, descriptions 1024, other text 2000).
 * - cleanGuide: a workspace's guide keeps its lines and tabs, as the bridge keeps them
 *   (src/workspace/bridge.ts checkAssistantTools); every other such character is a space.
 * - sanitizeJson: plain JSON only, depth ≤ 8, ≤ 200 keys per object, ≤ 200 items per
 *   list, ≤ 32 KB in all; anything cut is marked `truncated`.
 * - resultText: a failed call's error keeps its hint and its detail (sanitizeJson, ≤ 4 KB),
 *   so the model reads how to fix it; a result's summary is the log's, never the model's.
 * - checkImage: PNG, JPEG or WebP by their first bytes, ≤ 1.5 MB, ≤ 2000 px a side;
 *   checkImages: a result's images, ≤ 4: one that fails makes the call fail with why
 *   (`too_large` or `bad_result`), never dropped quietly; checkPromptImages: a turn start's
 *   reference pictures, ≤ 4, each as checkImage and of the type it declares.
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
/** The most of a tool error's detail the model gets, as JSON (sanitizeJson's rules). */
export const ERROR_DETAIL_BYTES = 4 * 1024;
/** A tool's confirm note (characters): what the question before a destructive call says it does. */
export const CONFIRM_NOTE_MAX = 120;
/**
 * What an escalation found, at most, for a tool that words its own card (gateText): the card's
 * copy names what converts or goes (core host tools spec 14.2), longer than a confirm note.
 */
export const GATE_NOTE_MAX = 600;

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

/**
 * A workspace's guide as the model gets it: its line breaks (CR LF and CR as LF) and tabs
 * kept, as the page's bridge keeps them, so a numbered procedure or a table stays one; every
 * other control, separator or bidi mark a space; at most `max` characters.
 */
export function cleanGuide(raw: unknown, max: number): string {
  const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  return cut(
    text
      .replace(/\r\n?/g, '\n')
      .replace(CONTROLS, (c) => (c === '\n' || c === '\t' ? c : ' '))
      .trim(),
    max,
  );
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
  error?: { code: string; message: string; hint?: string; detail?: unknown };
}

/** At most this much of a result's free text. */
const RESULT_TEXT_BYTES = 16 * 1024;

/**
 * The text a tool result reaches the model as: `{"tool","ok","data","text"}` or
 * `{"tool","ok":false,"error":{"code","message","hint"?,"detail"?}}`, cleaned, ≤ 32 KB,
 * `"truncated": true` when cut (an error's detail is cut at 4 KB).
 */
export function resultText(tool: string, r: ResultBody): string {
  const name = cleanText(tool, TEXT_CAPS.name);
  if (!r.ok) {
    const e = r.error ?? { code: 'failed', message: 'The tool failed.' };
    const error: Record<string, unknown> = {
      code: cleanText(e.code, 64) || 'failed',
      message: cleanText(e.message, TEXT_CAPS.other),
      ...(e.hint ? { hint: cleanText(e.hint, TEXT_CAPS.other) } : {}),
    };
    let cut = false;
    if (e.detail !== undefined && e.detail !== null) {
      const detail = sanitizeJson(e.detail, ERROR_DETAIL_BYTES);
      error.detail = detail.value;
      cut = detail.truncated;
    }
    return JSON.stringify({ tool: name, ok: false, error, ...(cut ? { truncated: true } : {}) });
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
  | { ok: false; code: 'too_large' | 'bad_result'; error: string };

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
  if (b.length > IMAGE_CAPS.bytes) return { ok: false, code: 'too_large', error: `The image is larger than ${IMAGE_CAPS.bytes / (1024 * 1024)} MB.` };
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
  if (!mediaType) return { ok: false, code: 'bad_result', error: 'Only PNG, JPEG and WebP images can be sent.' };
  if (!size || !size.width || !size.height) return { ok: false, code: 'bad_result', error: 'The image could not be read.' };
  if (size.width > IMAGE_CAPS.side || size.height > IMAGE_CAPS.side) {
    return { ok: false, code: 'too_large', error: `The image is ${size.width}×${size.height} px; at most ${IMAGE_CAPS.side} px a side can be sent.` };
  }
  return { ok: true, mediaType, ...size };
}

/**
 * A tool result's images as the model gets them, each checked (checkImage) and given its true
 * type and size; or why the call fails instead: `too_large` (more than 4, or one over 1.5 MB or
 * 2000 px a side) or `bad_result` (not a PNG, JPEG or WebP the app can read). An image is never
 * dropped quietly: the model would get a result without it, and the turn's log would still
 * count it.
 */
export function checkImages(
  list: readonly unknown[] | undefined,
): { ok: true; images: ImagePart[] } | { ok: false; code: 'too_large' | 'bad_result'; message: string } {
  const all = Array.isArray(list) ? list : [];
  if (all.length > IMAGE_CAPS.perResult) {
    return { ok: false, code: 'too_large', message: `The tool's result is too large: it has more than ${IMAGE_CAPS.perResult} images.` };
  }
  const images: ImagePart[] = [];
  for (const [i, img] of all.entries()) {
    const raw = img && typeof img === 'object' ? (img as { base64?: unknown }).base64 : undefined;
    const base64 = typeof raw === 'string' ? raw : '';
    const c: ImageCheck = typeof raw === 'string' ? checkImage(Buffer.from(base64, 'base64')) : { ok: false, code: 'bad_result', error: 'It is not an image.' };
    if (!c.ok) {
      const what = c.code === 'too_large' ? "The tool's result is too large" : "The tool's result was refused";
      return { ok: false, code: c.code, message: `${what} (image ${i + 1} of ${all.length}): ${c.error}` };
    }
    images.push({ type: 'image', mediaType: c.mediaType, base64, width: c.width, height: c.height });
  }
  return { ok: true, images };
}

/** A tool result part for the next user message (text as resultText, images already checked). */
export function capResult(callId: string, tool: string, r: ResultBody, images: ImagePart[] = []): ToolResultPart {
  return { type: 'tool_result', callId, isError: !r.ok, text: resultText(tool, r), images: images.slice(0, IMAGE_CAPS.perResult) };
}

/** The media types a turn's reference picture may declare. */
const PROMPT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A turn start's reference pictures (POST /api/assistant/turns `images`): at most 4 of
 * `{media_type: 'image/png'|'image/jpeg'|'image/webp', data: <base64>}`, each checked as a tool
 * result's (checkImage: its first bytes, ≤ 1.5 MB, ≤ 2000 px a side) and of the type it says.
 * Absent (undefined or null) is none. Refused with `bad_images` or `images_too_large` and why.
 */
export function checkPromptImages(raw: unknown): { ok: true; images: ImagePart[] } | { ok: false; code: 'bad_images' | 'images_too_large'; message: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, code: 'bad_images', message: 'images is a list of {media_type, data}.' };
  if (raw.length > IMAGE_CAPS.perResult) return { ok: false, code: 'images_too_large', message: `At most ${IMAGE_CAPS.perResult} pictures go with a request.` };
  const images: ImagePart[] = [];
  for (const [i, img] of raw.entries()) {
    const what = `Picture ${i + 1} of ${raw.length}`;
    const r = img && typeof img === 'object' && !Array.isArray(img) ? (img as { media_type?: unknown; data?: unknown }) : null;
    if (!r || typeof r.media_type !== 'string' || !PROMPT_IMAGE_TYPES.has(r.media_type)) {
      return { ok: false, code: 'bad_images', message: `${what}: media_type is image/png, image/jpeg or image/webp.` };
    }
    // Base64 of 1.5 MB is about 2 MB of text: anything longer is too large before it is decoded.
    if (typeof r.data !== 'string' || !r.data) return { ok: false, code: 'bad_images', message: `${what}: data is the image as base64.` };
    if (r.data.length > Math.ceil(IMAGE_CAPS.bytes / 3) * 4 + 4) {
      return { ok: false, code: 'images_too_large', message: `${what}: the image is larger than ${IMAGE_CAPS.bytes / (1024 * 1024)} MB.` };
    }
    if (r.data.length % 4 !== 0 || !BASE64_TEXT.test(r.data)) return { ok: false, code: 'bad_images', message: `${what}: data is not base64.` };
    const c = checkImage(Buffer.from(r.data, 'base64'));
    if (!c.ok) return { ok: false, code: c.code === 'too_large' ? 'images_too_large' : 'bad_images', message: `${what}: ${c.error}` };
    if (c.mediaType !== r.media_type) return { ok: false, code: 'bad_images', message: `${what}: it is ${c.mediaType}, not ${r.media_type}.` };
    images.push({ type: 'image', mediaType: c.mediaType, base64: r.data, width: c.width, height: c.height });
  }
  return { ok: true, images };
}
