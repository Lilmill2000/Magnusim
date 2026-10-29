/**
 * The person's file attachments (core host tools spec 13, C9): geometry files and drawings
 * (SVG, DXF) dropped on the dock, kept on this PC until the AI uses them by attachment_id.
 *
 *   <assistant home>/attachments/<id>/file        the bytes, as they came
 *   <assistant home>/attachments/<id>/meta.json   {name, bytes, sha256, format, link_tab,
 *                                                 conversation, created_at, pid}
 *
 * - receive(): POST /api/assistant/attachments streams the request body here (never through
 *   readJsonBody): a geometry or drawing extension, at most ATTACHMENT_LIMITS.bytes (a drawing:
 *   drawingBytes), and first bytes that say the same format (sniffGeometry, sniffDrawing). The
 *   id is `att-<16 hex>`. An SVG may carry a script, so the bytes go back to a browser only as
 *   application/octet-stream, never as what they are: GET /api/assistant/relay/attachment, to
 *   a workspace page's tool call of the conversation, is the one route that serves them.
 * - A turn's start checks its `attachments` (check(): each kept, from the tab that starts the
 *   turn, unbound or bound to its conversation) and binds them to its conversation (bind(), in
 *   the start's synchronous step).
 * - open(id, conversation): the stored file as a stream, for import_file and that route; null for
 *   an id that is not kept or is another conversation's (both answer not_found).
 * - Lifetime: a conversation's attachments go when it is forgotten or expires
 *   (dropConversation). sweep() takes what nothing can use any more: anything older than 24 h;
 *   another Magnusim's that ended (its pid gone); this process's bound to a conversation no
 *   server here still has; unbound ones older than an hour (the person may still be typing the
 *   message they go with). It runs at boot and every 6 h (startSweeps).
 *
 * The index is kept in memory per folder, on globalThis (a Vite re-import of this module shares
 * it); the files are the truth across processes. Nothing here runs when the module loads, and
 * nothing creates the folder before a file comes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensurePrivateDir, readJsonFile, writeFileAtomic } from './files.ts';
import { assistantHome } from './home.ts';
import { alog } from './log.ts';
import { cleanText } from './sanitize.ts';

export const ATTACHMENT_LIMITS = Object.freeze({
  /** One file (500 MB). */
  bytes: 500 * 1024 * 1024,
  /** One drawing (20 MB). */
  drawingBytes: 20 * 1024 * 1024,
  /** Files per message. */
  perMessage: 4,
  /** Anything older goes at the next sweep. */
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** An unbound one is kept at least this long (its message may not be sent yet). */
  unboundMs: 60 * 60 * 1000,
  /** The sweep's period. */
  sweepEveryMs: 6 * 60 * 60 * 1000,
  /** How much of the start sniffGeometry and sniffDrawing read. */
  headBytes: 4096,
});

export type GeometryFormat = 'step' | 'iges' | 'brep' | 'stl' | 'obj' | 'ply';
export type DrawingFormat = 'svg' | 'dxf';
export type AttachmentFormat = GeometryFormat | DrawingFormat;
/** What the file is to the AI: a geometry file import_file adds, or a drawing a workspace imports. */
export type AttachmentKind = 'geometry' | 'drawing';

/** Each extension the dock and the route take, and the format its bytes must be. */
export const GEOMETRY_EXTENSIONS: Readonly<Record<string, GeometryFormat>> = Object.freeze({
  '.step': 'step',
  '.stp': 'step',
  '.iges': 'iges',
  '.igs': 'iges',
  '.brep': 'brep',
  '.brp': 'brep',
  '.stl': 'stl',
  '.obj': 'obj',
  '.ply': 'ply',
});

/** The drawings' extensions, the same way. */
export const DRAWING_EXTENSIONS: Readonly<Record<string, DrawingFormat>> = Object.freeze({
  '.svg': 'svg',
  '.dxf': 'dxf',
});

const FORMAT_LABEL: Readonly<Record<AttachmentFormat, string>> = Object.freeze({ step: 'STEP', iges: 'IGES', brep: 'BREP', stl: 'STL', obj: 'OBJ', ply: 'PLY', svg: 'SVG', dxf: 'DXF' });

export const ONLY_FILES_TEXT = 'Only pictures, geometry files (STEP, IGES, BREP, STL, OBJ, PLY) and drawings (SVG, DXF) can be attached.';
export const tooLargeText = (name: string): string => `${name} is larger than 500 MB. Import it with + Add geometry.`;
export const drawingTooLargeText = (name: string): string => `${name} is larger than 20 MB, the limit for a drawing.`;
export const notFormatText = (name: string, f: AttachmentFormat): string => `${name} doesn't look like ${f === 'svg' ? 'an' : 'a'} ${FORMAT_LABEL[f]} file.`;
export const emptyFileText = (name: string): string => `${name} is empty.`;
export const ATTACHMENT_GONE_TEXT = 'An attached file is no longer kept on this PC. Remove it and attach it again.';
/** open() found nothing for the conversation: import_file's and the page's read's not_found. */
export const NO_SUCH_ATTACHMENT_TEXT = 'No such attached file in this conversation.';
export const ATTACHMENTS_NEED_WINDOW_TEXT = 'Files are attached in the Assistant panel of a Magnusim window, and sent from that window.';
export const tooManyFilesText = (n: number): string => `At most ${n} files per message.`;

const ID_RE = /^att-[0-9a-f]{16}$/;

export function isAttachmentId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

export interface AttachmentMeta {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  format: AttachmentFormat;
  /** The app tab whose live relay link sent it: only a turn started from that tab may use it. */
  link_tab: string;
  /** The conversation it is bound to (its first turn's), or null until then. */
  conversation: string | null;
  created_at: string;
  /** The process that received it (another Magnusim on this PC keeps its own). */
  pid: number;
}

/** What a turn carries of an attachment: its summary's `attachments` and the prompt line. */
export interface AttachmentRef {
  id: string;
  name: string;
  bytes: number;
  kind: AttachmentKind;
}

/** An attachment opened for import_file: its facts and a stream of its bytes (the caller reads or destroys it). */
export interface OpenedAttachment {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  format: AttachmentFormat;
  stream: ReadStream;
}

export type Refusal = { ok: false; status: number; code: string; error: string };
const refusal = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** "4.2 MB", "12 KB", "512 bytes" (1024-based, as the dock's chip). */
export function sizeText(bytes: number): string {
  const n = Math.max(0, Math.floor(bytes));
  if (n < 1024) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A file's name as the person reads it and the model gets it: its last path part, cleaned, no double quotes. */
export function cleanFileName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  const last = s.split(/[\\/]/).pop() ?? '';
  return cleanText(last, 120).replace(/"/g, "'");
}

/** The extension's format (".STEP" too), or null for any other. */
export function formatOfName(name: string): AttachmentFormat | null {
  const m = /(\.[A-Za-z]{3,4})$/.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return GEOMETRY_EXTENSIONS[ext] ?? DRAWING_EXTENSIONS[ext] ?? null;
}

/** A drawing for SVG and DXF, else a geometry file (the route's `kind`, the model's line). */
export function kindOfFormat(f: AttachmentFormat): AttachmentKind {
  return Object.values(DRAWING_EXTENSIONS).includes(f as DrawingFormat) ? 'drawing' : 'geometry';
}

function isFormat(v: unknown): v is AttachmentFormat {
  return typeof v === 'string' && (Object.values(GEOMETRY_EXTENSIONS) as string[]).concat(Object.values(DRAWING_EXTENSIONS)).includes(v);
}

const LINE_OPENING: Readonly<Record<AttachmentKind, string>> = Object.freeze({ geometry: 'Attached geometry file', drawing: 'Attached drawing' });

/** The model's line for one file (spec 13.2), saying what kind of file it is (no kind: a geometry file). */
export function attachmentLine(a: AttachmentRef): string {
  return `[${LINE_OPENING[a.kind] ?? LINE_OPENING.geometry}: "${cleanFileName(a.name)}", ${sizeText(a.bytes)}, attachment_id ${a.id}]`;
}

/** The lines for a turn's files, one per file; '' with none. */
export function attachmentLines(list: readonly AttachmentRef[] | undefined): string {
  return (list ?? []).map(attachmentLine).join('\n');
}

/**
 * The format a file's first bytes say (`head`: at least its first 4 KB, or all of it), with its
 * total size for a binary STL (84 + 50 bytes a triangle). null: none of the six.
 */
export function sniffGeometry(head: Buffer, total: number): GeometryFormat | null {
  if (total >= 84 && head.length >= 84 && 84 + 50 * head.readUInt32LE(80) === total) return 'stl';
  let text = head.toString('latin1');
  if (text.startsWith('ï»¿')) text = text.slice(3);
  text = text.replace(/^\s+/, '');
  if (/^ISO-10303-21\s*;/.test(text)) return 'step';
  if (/^(DBRep_DrawableShape\s+)?CASCADE Topology V\d/.test(text)) return 'brep';
  if (/^ply\r?\n/.test(text) && /\bformat (ascii|binary_little_endian|binary_big_endian)\b/.test(text)) return 'ply';
  if (/^solid\b/.test(text) && /\b(facet|endsolid)\b/.test(text)) return 'stl';
  const first = head.toString('latin1').split(/\r?\n/)[0];
  if (first.length >= 73 && first[72] === 'S' && /^\s*\d+\s*$/.test(first.slice(73, 80))) return 'iges';
  if (!head.includes(0)) {
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      return /^(v|vn|vt|vp|f|l|p|o|g|s|mtllib|usemtl)\s/.test(l) ? 'obj' : null;
    }
  }
  return null;
}

const BINARY_DXF = Buffer.from('AutoCAD Binary DXF\r\n\x1a\0', 'latin1');

/** The head as text: UTF-16 by its BOM, else its bytes as latin1 (a UTF-8 BOM dropped). */
function headText(head: Buffer): string {
  if (head[0] === 0xff && head[1] === 0xfe) return head.subarray(2).toString('utf16le');
  // Big-endian: swapped to little-endian (swap16 wants an even length; a cut head loses a byte).
  if (head[0] === 0xfe && head[1] === 0xff) return Buffer.from(head.subarray(2, head.length - (head.length % 2))).swap16().toString('utf16le');
  const text = head.toString('latin1');
  return text.startsWith('ï»¿') ? text.slice(3) : text;
}

/**
 * The drawing format a file's first bytes say (`head`: at least its first 4 KB, or all of it).
 * SVG: an <svg> root element after the XML prolog (its declaration, processing instructions,
 * comments, a DOCTYPE). DXF: ASCII, group code 0 then SECTION after blank lines and 999
 * comments; or the binary DXF sentinel. null: neither.
 */
export function sniffDrawing(head: Buffer): DrawingFormat | null {
  if (head.length >= BINARY_DXF.length && head.subarray(0, BINARY_DXF.length).equals(BINARY_DXF)) return 'dxf';
  const text = headText(head);
  let s = text;
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?')) {
      const end = s.indexOf('?>', 2);
      if (end < 0) return null;
      s = s.slice(end + 2);
    } else if (s.startsWith('<!--')) {
      const end = s.indexOf('-->', 4);
      if (end < 0) return null;
      s = s.slice(end + 3);
    } else if (/^<!DOCTYPE\s/.test(s)) {
      const close = s.indexOf('>');
      if (close < 0) return null;
      const open = s.indexOf('[');
      if (open >= 0 && open < close) {
        // Its internal subset may hold a '>' of its own: the DOCTYPE ends at "]>".
        const m = /\]\s*>/.exec(s.slice(open));
        if (!m) return null;
        s = s.slice(open + m.index + m[0].length);
      } else s = s.slice(close + 1);
    } else break;
  }
  if (/^<([A-Za-z_][\w.-]*:)?svg[\s>/]/.test(s)) return 'svg';
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  while (i + 1 < lines.length && lines[i].trim() === '999') i += 2;
  return i + 1 < lines.length && lines[i].trim() === '0' && lines[i + 1].trim() === 'SECTION' ? 'dxf' : null;
}

// ---------------------------------------------------------------- the store

export interface StoreOptions {
  dir: string;
  now?: () => number;
  maxBytes?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (err: unknown) => String((err as { code?: unknown } | null)?.code || '');
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Removes a folder, retrying while Windows says a file in it is open (a stream import_file reads). */
async function removeDir(path: string): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (!LOCK_CODES.has(codeOf(err)) || attempt >= 5) return false;
      await sleep(100 * (attempt + 1));
    }
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it runs, as another account's.
    return codeOf(err) === 'EPERM';
  }
}

function metaOf(v: unknown, id: string): AttachmentMeta | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const format = isFormat(m.format) ? m.format : null;
  if (!format || typeof m.name !== 'string' || typeof m.bytes !== 'number' || typeof m.created_at !== 'string') return null;
  return {
    id,
    name: m.name,
    bytes: m.bytes,
    sha256: typeof m.sha256 === 'string' ? m.sha256 : '',
    format,
    link_tab: typeof m.link_tab === 'string' ? m.link_tab : '',
    conversation: typeof m.conversation === 'string' ? m.conversation : null,
    created_at: m.created_at,
    pid: typeof m.pid === 'number' ? m.pid : 0,
  };
}

export class AttachmentStore {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly now: () => number;
  private readonly index = new Map<string, AttachmentMeta>();
  /** Whether the conversation still lives in a server of this process (each server's turn manager answers). */
  private readonly lives = new Set<(conversation: string) => boolean>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepUsers = 0;
  private sweeping: Promise<number> | null = null;

  constructor(o: StoreOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    this.maxBytes = o.maxBytes ?? ATTACHMENT_LIMITS.bytes;
  }

  private folder(id: string): string {
    return join(this.dir, id);
  }

  /** The kept attachment of this process (null for any other id). */
  get(id: unknown): AttachmentMeta | null {
    if (!isAttachmentId(id)) return null;
    const m = this.index.get(id);
    return m ? { ...m } : null;
  }

  /** What tests see: every kept attachment of this process. */
  snapshot(): AttachmentMeta[] {
    return [...this.index.values()].map((m) => ({ ...m }));
  }

  /**
   * One file from the request body: `name` the person's file name, `declared` its
   * Content-Length (when sent), `linkTab` the tab whose live link sent it. Answers its meta, or
   * a refusal (nothing kept then).
   */
  async receive(body: Readable, o: { name: unknown; declared?: string | number | undefined; linkTab: string }): Promise<{ ok: true; meta: AttachmentMeta } | Refusal> {
    const name = cleanFileName(o.name);
    if (!name) return refusal(400, 'bad_name', 'Send the file name as ?name=<file name>.');
    const expected = formatOfName(name);
    if (!expected) return refusal(400, 'bad_type', ONLY_FILES_TEXT);
    const drawing = kindOfFormat(expected) === 'drawing';
    const max = drawing ? Math.min(this.maxBytes, ATTACHMENT_LIMITS.drawingBytes) : this.maxBytes;
    const largeText = drawing ? drawingTooLargeText(name) : tooLargeText(name);
    if (o.declared !== undefined && o.declared !== '') {
      const n = Number(o.declared);
      if (!Number.isFinite(n) || n < 0) return refusal(400, 'bad_request', 'Invalid Content-Length.');
      if (n > max) return refusal(413, 'too_large', largeText);
    }
    let id = `att-${randomBytes(8).toString('hex')}`;
    while (this.index.has(id)) id = `att-${randomBytes(8).toString('hex')}`;
    const folder = this.folder(id);
    const part = join(folder, 'file.part');
    const hash = createHash('sha256');
    const heads: Buffer[] = [];
    let headLen = 0;
    let total = 0;
    const tooLarge = Object.assign(new Error('too large'), { code: 'too_large' });
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        total += chunk.length;
        if (total > max) {
          done(tooLarge);
          return;
        }
        hash.update(chunk);
        if (headLen < ATTACHMENT_LIMITS.headBytes) {
          heads.push(Buffer.from(chunk.subarray(0, ATTACHMENT_LIMITS.headBytes - headLen)));
          headLen += Math.min(chunk.length, ATTACHMENT_LIMITS.headBytes - headLen);
        }
        done(null, chunk);
      },
    });
    try {
      await ensurePrivateDir(this.dir);
      await ensurePrivateDir(folder);
      // The request is not destroyed on a refusal, so the answer still reaches the window.
      const src = typeof (body as { iterator?: unknown }).iterator === 'function' ? (body as Readable).iterator({ destroyOnReturn: false }) : body;
      await pipeline(src, meter, createWriteStream(part, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await removeDir(folder);
      if (err === tooLarge) return refusal(413, 'too_large', largeText);
      if (codeOf(err) === 'ENOSPC') return refusal(507, 'disk_full', `There is no room on this PC's disk for ${name}.`);
      throw err;
    }
    if (total === 0) {
      await removeDir(folder);
      return refusal(400, 'empty_file', emptyFileText(name));
    }
    const head = Buffer.concat(heads);
    const format = drawing ? sniffDrawing(head) : sniffGeometry(head, total);
    if (format !== expected) {
      await removeDir(folder);
      return refusal(400, 'bad_type', notFormatText(name, expected));
    }
    const meta: AttachmentMeta = {
      id,
      name,
      bytes: total,
      sha256: hash.digest('hex'),
      format,
      link_tab: o.linkTab,
      conversation: null,
      created_at: new Date(this.now()).toISOString(),
      pid: process.pid,
    };
    try {
      await rename(part, join(folder, 'file'));
      await this.writeMeta(meta);
    } catch (err) {
      await removeDir(folder);
      throw err;
    }
    this.index.set(id, meta);
    alog('info', 'attachment kept', { id, bytes: total, format });
    return { ok: true, meta: { ...meta } };
  }

  private async writeMeta(m: AttachmentMeta): Promise<void> {
    const { id: _id, ...rest } = m;
    await writeFileAtomic(join(this.folder(m.id), 'meta.json'), JSON.stringify(rest, null, 2));
  }

  /**
   * A turn's `attachments` checked (synchronously, from memory): at most perMessage distinct
   * ids, each kept, sent from `tab` (the window that starts the turn) and unbound or bound to
   * `conversation` (null: a new one). Answers their refs in order, or the refusal.
   */
  check(raw: unknown, o: { tab: string | null; conversation: string | null }): { ok: true; refs: AttachmentRef[] } | Refusal {
    if (raw === undefined || raw === null) return { ok: true, refs: [] };
    if (!Array.isArray(raw) || raw.some((x) => !isAttachmentId(x))) return refusal(400, 'bad_attachments', 'attachments is a list of attachment ids (att-…).');
    const ids = raw as string[];
    if (new Set(ids).size !== ids.length) return refusal(400, 'bad_attachments', 'An attachment is listed twice.');
    if (ids.length > ATTACHMENT_LIMITS.perMessage) return refusal(400, 'bad_attachments', tooManyFilesText(ATTACHMENT_LIMITS.perMessage));
    if (!ids.length) return { ok: true, refs: [] };
    if (!o.tab) return refusal(400, 'attachments_need_window', ATTACHMENTS_NEED_WINDOW_TEXT);
    const refs: AttachmentRef[] = [];
    for (const id of ids) {
      const m = this.index.get(id);
      // Not kept, another window's, or another conversation's: the same answer for each.
      if (!m || m.link_tab !== o.tab || (m.conversation !== null && m.conversation !== o.conversation)) return refusal(409, 'attachment_gone', ATTACHMENT_GONE_TEXT);
      refs.push({ id: m.id, name: m.name, bytes: m.bytes, kind: kindOfFormat(m.format) });
    }
    return { ok: true, refs };
  }

  /** Binds checked attachments to their turn's conversation: in memory now, on disk soon after. */
  bind(ids: readonly string[], conversation: string): void {
    for (const id of ids) {
      const m = this.index.get(id);
      if (!m || m.conversation === conversation) continue;
      m.conversation = conversation;
      this.writeMeta(m).catch((err: unknown) => alog('warn', 'attachment bind not saved', { id, error: String((err as Error)?.message ?? err).slice(0, 200) }));
    }
  }

  /**
   * The stored file of `id` as a stream, for the conversation's import (spec 13.2) or a workspace
   * tool call's read: null when it is not kept, or not bound to `conversation` (an unbound one
   * isn't any conversation's yet). Its bytes reach a browser only as application/octet-stream.
   */
  async open(id: unknown, conversation: string | null): Promise<OpenedAttachment | null> {
    const m = this.get(id);
    if (!m || !conversation || m.conversation !== conversation) return null;
    const file = join(this.folder(m.id), 'file');
    try {
      const s = await stat(file);
      if (!s.isFile() || s.size !== m.bytes) return null;
    } catch {
      return null;
    }
    return { id: m.id, name: m.name, bytes: m.bytes, sha256: m.sha256, format: m.format, stream: createReadStream(file) };
  }

  /** Removes one attachment (its folder; it stays listed when Windows holds it, for the next sweep). */
  async remove(id: string): Promise<boolean> {
    if (!isAttachmentId(id)) return false;
    const gone = await removeDir(this.folder(id));
    if (gone) this.index.delete(id);
    return gone;
  }

  /** A conversation forgotten or expired: its attachments go. */
  async dropConversation(conversation: string): Promise<number> {
    const ids = [...this.index.values()].filter((m) => m.conversation === conversation).map((m) => m.id);
    let n = 0;
    for (const id of ids) if (await this.remove(id)) n += 1;
    return n;
  }

  /** A server's turn manager says which conversations live; its shutdown takes the check back. */
  watchConversations(lives: (conversation: string) => boolean): () => void {
    this.lives.add(lives);
    return () => {
      this.lives.delete(lives);
    };
  }

  private alive(conversation: string): boolean {
    for (const fn of this.lives) {
      try {
        if (fn(conversation)) return true;
      } catch {
        /* a check that throws says nothing */
      }
    }
    return false;
  }

  /** Whether the sweep takes `m` at `now` (see the header). */
  private stale(m: AttachmentMeta, now: number): boolean {
    const born = Date.parse(m.created_at);
    const age = Number.isFinite(born) ? now - born : Infinity;
    if (age > ATTACHMENT_LIMITS.maxAgeMs) return true;
    if (m.pid !== process.pid) return !pidAlive(m.pid);
    if (m.conversation !== null) return !this.alive(m.conversation);
    return age > ATTACHMENT_LIMITS.unboundMs;
  }

  /**
   * Removes what nothing can use any more (see the header); `later` moves the clock on (tests).
   * Reads the folder, so a previous run's files are found too. Answers how many went.
   */
  sweep(o: { later?: number } = {}): Promise<number> {
    if (this.sweeping) return this.sweeping;
    const run = this.sweepOnce(this.now() + (o.later ?? 0)).finally(() => {
      this.sweeping = null;
    });
    this.sweeping = run;
    return run;
  }

  private async sweepOnce(now: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') return 0;
      throw err;
    }
    let n = 0;
    for (const id of names) {
      if (!isAttachmentId(id)) continue;
      let m = this.index.get(id) ?? null;
      if (!m) {
        const r = await readJsonFile(join(this.folder(id), 'meta.json')).catch(() => ({ state: 'bad' as const }));
        m = r.state === 'ok' ? metaOf(r.value, id) : null;
        // No meta: a receive cut short (or a folder someone made): it goes once it is an hour old.
        if (!m) {
          const age = await stat(this.folder(id)).then((s) => now - s.mtimeMs, () => 0);
          if (age > ATTACHMENT_LIMITS.unboundMs && (await removeDir(this.folder(id)))) n += 1;
          continue;
        }
      }
      if (this.stale(m, now) && (await this.remove(id))) n += 1;
    }
    if (n) alog('info', 'attachments swept', { removed: n });
    return n;
  }

  /** The boot sweep (soon after, not in the server's start) and one every 6 h while any server uses the store. */
  startSweeps(): () => void {
    this.sweepUsers += 1;
    if (!this.sweepTimer) {
      const boot = setTimeout(() => void this.sweep().catch(() => undefined), 1000);
      boot.unref?.();
      this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), ATTACHMENT_LIMITS.sweepEveryMs);
      this.sweepTimer.unref?.();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.sweepUsers -= 1;
      if (this.sweepUsers <= 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    };
  }

  /** Tests: everything forgotten and removed. */
  async clear(): Promise<void> {
    this.index.clear();
    await removeDir(this.dir);
  }
}

const STORES = Symbol.for('magnusim.assistant.attachments');

/** The store of `<assistant home>/attachments` (one per folder per process). */
export function attachmentStore(dir: string = join(assistantHome(), 'attachments')): AttachmentStore {
  const g = globalThis as unknown as Record<symbol, Map<string, AttachmentStore> | undefined>;
  const all = (g[STORES] ??= new Map());
  let s = all.get(dir);
  if (!s) {
    s = new AttachmentStore({ dir });
    all.set(dir, s);
  }
  return s;
}

/**
 * The import's door (spec 4.11, 13.2): import_file calls attachments.open(id, conversation)
 * with the calling turn's conversation and streams the file into the raw geometry import.
 */
export const attachments = {
  open: (id: unknown, conversation: string | null): Promise<OpenedAttachment | null> => attachmentStore().open(id, conversation),
};
