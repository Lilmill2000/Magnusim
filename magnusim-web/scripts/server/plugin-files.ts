/**
 * A plugin's own files in a project (API 1.2): projects/<pid>/plugins/<key>/<rel>.
 *
 * The same folder PluginData and ws.data use; ws.files is its binary view. Bytes
 * never pass through the Python worker: reads stream from an open file here, and
 * writes arrive in chunks into a staging file (<plugin folder>/.magnusim-staging/
 * <upload>.part) that one commit renames over the target, so a reader sees the
 * old file or the new one, never half of either.
 *
 * Paths follow one set of rules, mirrored in magnusim_sdk.data.data_rel (both
 * pass python/tests/fixtures/plugin-file-paths.json). Every call also checks
 * where the path really lands (links, junctions, Windows short names) before it
 * touches the disk.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp, type BigIntStats, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { projectDir as catalogProjectDir } from '../w17-sim-catalog.js';
import type { RequestContext, Router } from './router.ts';

const MB = 1024 * 1024;
/** What the bridge sends per chunk, and the most one chunk may carry. */
export const CHUNK_BYTES = 16 * MB;
export const MAX_CHUNK_BYTES = 32 * MB;
/** An upload with no call for this long is dropped, with its staging file. */
export const UPLOAD_IDLE_MS = 10 * 60_000;
export const MAX_OPEN_UPLOADS = 4;
/** Free space a write must leave on the disk. */
export const DISK_SPARE_BYTES = 256 * MB;
export const LIST_MAX = 10_000;
/**
 * Files and folders a plugin's folder may hold in a project (magnusim_sdk.data
 * MAX_ENTRIES): empty files take no quota but do take disk, and every write walks the folder.
 */
export const MAX_ENTRIES = 100_000;
/** A plugin's [files] limits when its manifest sets none. */
export const DEFAULT_MAX_FILE_BYTES = 64 * MB;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * MB;

const STAGING = '.magnusim-staging';
const STALE_PART_MS = 60 * 60_000;
const WALK_MAX = 100_000;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRIES = 8;
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const DISK_FULL = new Set(['ENOSPC', 'EDQUOT']);
const TMP_JSON = /^\.tmp-.*\.json$/;
/** Temp files magnusim_sdk.data writes next to a file, which keep the file's extension
 * (a stopped job can leave one behind). */
const PY_TEMP = /^\.magnusim-(?:[0-9a-f]{16}\.part(?:\.[A-Za-z0-9]{1,16})?|tmp-.*\.json)$/;
const WIN = process.platform === 'win32';
const STUDY_RECORD_WRITE = "a study's record changes only through the study calls";
const STUDY_FOLDER_WRITE = 'only the study calls write directly in the studies folder';
const STUDY_REMOVE = 'a study is removed only through the study calls';
// The years Python's datetime can show (an mtime outside them is "" on both sides).
const MIN_MS = -62_135_596_800_000n;
const MAX_MS = 253_402_300_799_999n;

/** A refused call: its HTTP status, a code the frame can act on, and extra fields. */
export class PluginFileError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PluginFileError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface FileInfo {
  /** From the plugin's folder, with "/", spelled as on disk. */
  rel: string;
  size: number;
  /** ISO-8601 UTC, whole milliseconds. */
  mtime: string;
  etag: string;
}

/** A plugins.list row, as far as files care. */
export interface PluginRow {
  key: string;
  status?: string;
  files?: { max_file_bytes?: number; max_total_bytes?: number } | null;
}

/** The disk calls tests replace. */
export interface FsOps {
  rename: (from: string, to: string) => Promise<void>;
  statfs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  createWriteStream: (path: string, opts: { flags: string; start: number }) => Writable;
  mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
  unlink: (path: string) => Promise<void>;
  rm: (path: string, opts: { recursive: true; force: true; maxRetries: number; retryDelay: number }) => Promise<void>;
}

export interface PluginFilesOptions {
  /** The plugin list (routes.ts shares its cached plugins.list). */
  plugins: () => Promise<PluginRow[]>;
  projectDir?: (projectId: string) => string;
  fsOps?: Partial<FsOps>;
  now?: () => number;
  /** MAX_ENTRIES (tests use a small one). */
  maxEntries?: number;
  /** The case_keys of this plugin's running OpenFOAM cases in a project (their folders are busy). */
  activeCases?: (projectId: string, plugin: string) => string[];
}

// ---- path rules (magnusim_sdk.data.data_rel is the Python copy) ----

const ASCII_SPACE = ' \t\n\v\f\r';
const FORBIDDEN = ':~<>"|?*';
// Windows also keeps COM and LPT with a superscript 1, 2 or 3.
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\.|$)/i;
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function invalidPath(why: string): PluginFileError {
  return new PluginFileError(400, 'invalid_path', `not a path in the plugin's folder: ${why}`);
}

function studyRecordError(message = STUDY_RECORD_WRITE): PluginFileError {
  return new PluginFileError(403, 'study_record', message);
}

function trimAscii(text: string): string {
  let a = 0;
  let b = text.length;
  while (a < b && ASCII_SPACE.includes(text[a])) a += 1;
  while (b > a && ASCII_SPACE.includes(text[b - 1])) b -= 1;
  return text.slice(a, b);
}

/** Lowercase A-Z only (the Python copy does the same). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function isReserved(part: string): boolean {
  return asciiLower(part).startsWith('.magnusim');
}

// Lengths are UTF-16 code units: what Windows' name limits count (and the Python copy).
function partProblem(part: string): string | null {
  if (part === '..') return "'..' is not allowed";
  for (const ch of part) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f || FORBIDDEN.includes(ch)) return 'a name has a character Windows does not allow';
  }
  if (part.endsWith('.') || part.endsWith(' ')) return 'a name may not end with a dot or a space';
  if (DEVICE_NAME.test(part)) return 'a name is a Windows device name';
  if (part.length > 255) return 'a name is longer than 255 characters';
  if (isReserved(part)) return 'names starting with .magnusim are kept for the app';
  return null;
}

function relParts(rel: unknown, allowEmpty: boolean): string[] {
  if (rel != null && typeof rel !== 'string') throw invalidPath('it is not text');
  const text = trimAscii(String(rel ?? '').replace(/\\/g, '/'));
  if (text.length > 1024) throw invalidPath('it is longer than 1024 characters');
  if (text.startsWith('/')) throw invalidPath('it must be relative');
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length) {
    if (allowEmpty) return [];
    throw invalidPath('it is empty');
  }
  for (const part of parts) {
    const why = partProblem(part);
    if (why) throw invalidPath(why);
  }
  if (parts.length > 32) throw invalidPath('it is more than 32 names deep');
  if (parts.join('/').length > 240) throw invalidPath('it is longer than 240 characters');
  return parts;
}

function studyNorm(part: string): string {
  return part.replace(/[ .]+$/, '').toLowerCase();
}

/** A case folder's key: its real parts from the plugin's folder, as Windows compares names. */
export function caseKeyOf(parts: readonly string[]): string {
  return parts.map(studyNorm).join('/');
}

export const CASE_BUSY = 'Stop the case, or wait for it to finish, before changing its files';

/**
 * A path is busy for a running case: a write inside one of its folders, or a
 * delete inside, of, or above one (by the names on disk, in any letter case).
 */
export function caseBusy(parts: readonly string[], keys: readonly string[], mode: 'write' | 'delete'): boolean {
  const norm = parts.map(studyNorm);
  return keys.some((key) => {
    const k = String(key || '').split('/').filter(Boolean);
    if (!k.length) return false;
    if (k.length <= norm.length && k.every((p, i) => p === norm[i])) return true;
    return mode === 'delete' && norm.length < k.length && norm.every((p, i) => p === k[i]);
  });
}

const CASE_PART_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** studies/<sid>/.../study.json in any spelling Windows opens as that file. */
export function isStudyRecord(parts: readonly string[]): boolean {
  const norm = parts.map(studyNorm);
  return norm.length >= 3 && norm[0] === 'studies' && norm[norm.length - 1] === 'study.json';
}

/**
 * studies or studies/<x>: only the study calls make and remove these, so no file
 * is written there (it would block a study's folder) and none is deleted.
 */
export function isStudyContainer(parts: readonly string[]): boolean {
  return parts.length >= 1 && parts.length <= 2 && studyNorm(parts[0]) === 'studies';
}

/** The study rules for a write: never a study's record, never directly in studies/. */
function checkWritable(parts: readonly string[]): void {
  if (isStudyRecord(parts)) throw studyRecordError();
  if (isStudyContainer(parts)) throw studyRecordError(STUDY_FOLDER_WRITE);
}

/**
 * A path in a plugin's folder as a caller may name it, normalised: "" (the folder
 * itself) only with allowEmpty (a list prefix); a write never names a study's
 * record, studies or studies/<x>.
 */
export function pluginFileRel(rel: unknown, opts: { write: boolean; allowEmpty?: boolean }): string {
  const parts = relParts(rel, !!opts.allowEmpty);
  if (opts.write) checkWritable(parts);
  return parts.join('/');
}

function validKey(key: string): boolean {
  return PLUGIN_KEY_RE.test(key) && !/[. ]$/.test(key) && !DEVICE_NAME.test(key);
}

// ---- the disk ----

function errCode(err: unknown): string {
  return String((err as NodeJS.ErrnoException | null)?.code || '');
}

/**
 * The real path: the native realpath of the deepest part that exists (it expands
 * Windows short names and fixes case, unlike JS realpathSync) plus the rest.
 */
export async function nativeResolved(path: string): Promise<string> {
  const abs = resolve(path);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (err) {
      if (!MISSING.has(errCode(err))) throw err;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.push(basename(cur));
    cur = parent;
  }
}

/** '"<ino>-<size>-<mtime ns>"' in hex; Python's file_info gives the same from os.stat. */
export function fileEtag(st: { ino: bigint; size: bigint; mtimeNs: bigint }): string {
  return `"${st.ino.toString(16)}-${st.size.toString(16)}-${st.mtimeNs.toString(16)}"`;
}

/** ISO-8601 UTC, nanoseconds floored to whole milliseconds (as Python's file_info). */
function isoMs(ns: bigint): string {
  const ms = ns >= 0n ? ns / 1_000_000n : -((-ns + 999_999n) / 1_000_000n);
  return ms < MIN_MS || ms > MAX_MS ? '' : new Date(Number(ms)).toISOString();
}

function infoOf(rel: string, st: BigIntStats): FileInfo {
  return { rel, size: Number(st.size), mtime: isoMs(st.mtimeNs), etag: fileEtag(st) };
}

function samePath(a: string, b: string): boolean {
  return WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** target's parts below root ([] for root itself), or null when it is not inside. */
function partsWithin(root: string, target: string): string[] | null {
  if (samePath(root, target)) return [];
  const head = root.endsWith(sep) ? root : root + sep;
  if (target.length <= head.length || !samePath(target.slice(0, head.length), head)) return null;
  return target.slice(head.length).split(sep).filter(Boolean);
}

function lockKey(path: string): string {
  return WIN ? path.toLowerCase() : path;
}

async function statOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await fsp.stat(path, { bigint: true });
  } catch (err) {
    if (MISSING.has(errCode(err))) return null;
    throw err;
  }
}

async function lstatOrNull(path: string): Promise<BigIntStats | null> {
  try {
    return await fsp.lstat(path, { bigint: true });
  } catch (err) {
    if (MISSING.has(errCode(err))) return null;
    throw err;
  }
}

async function readdirOrNone(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (MISSING.has(errCode(err))) return [];
    throw err;
  }
}

/** A rename or delete Windows refuses while another program holds the file: 8 tries, further apart each time. */
async function withRetries(op: () => Promise<void>): Promise<boolean> {
  for (let n = 0; n < RETRIES; n += 1) {
    try {
      await op();
      return true;
    } catch (err) {
      if (!RETRY_CODES.has(errCode(err))) throw err;
      if (n < RETRIES - 1) await delay(50 * (n + 1));
    }
  }
  return false;
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** A folder's entries with their lstat (null: gone meanwhile), asked for all at once. */
async function entriesOf(dir: string): Promise<Array<[string, BigIntStats | null]>> {
  const names = (await readdirOrNone(dir)).map((e) => e.name);
  const stats = await Promise.all(names.map((name) => lstatOrNull(join(dir, name))));
  return names.map((name, i) => [name, stats[i]]);
}

interface Usage {
  /** Bytes in its files. */
  bytes: number;
  /** Its files and folders (the count stops a little past the limit). */
  entries: number;
  /** Temp files magnusim_sdk left before staleBefore (a job stopped mid-write). */
  stale: string[];
}

/**
 * What the plugin's folder holds, as its quota counts it: no link followed, and
 * none of the app's own names (.magnusim*: staging, temp files), which the plugin
 * can neither see nor remove.
 */
async function folderUsage(root: string, limit: number, staleBefore: number): Promise<Usage> {
  const usage: Usage = { bytes: 0, entries: 0, stale: [] };
  const walk = async (dir: string): Promise<void> => {
    for (const [name, st] of await entriesOf(dir)) {
      if (usage.entries > limit) return;
      if (!st || st.isSymbolicLink()) continue;
      if (isReserved(name)) {
        if (st.isFile() && PY_TEMP.test(name) && Number(st.mtimeMs) < staleBefore) usage.stale.push(join(dir, name));
        continue;
      }
      usage.entries += 1;
      if (st.isDirectory()) await walk(join(dir, name));
      else if (st.isFile()) usage.bytes += Number(st.size);
    }
  };
  await walk(root);
  return usage;
}

/** Files under dir (never through a link), without the app's own and old JSON temp files. */
async function collectFiles(dir: string, rel: string[], out: FileInfo[]): Promise<void> {
  for (const [name, st] of await entriesOf(dir)) {
    if (out.length >= WALK_MAX) return;
    if (isReserved(name) || !st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) await collectFiles(join(dir, name), [...rel, name], out);
    else if (st.isFile() && !TMP_JSON.test(name)) out.push(infoOf([...rel, name].join('/'), st));
  }
}

/** Removes every link under dir (the links, never what they lead to) and counts its files. */
async function unlinkLinksCountFiles(dir: string): Promise<number> {
  let count = 0;
  for (const [name, st] of await entriesOf(dir)) {
    if (!st) continue;
    if (st.isSymbolicLink()) await fsp.unlink(join(dir, name));
    else if (st.isDirectory()) count += await unlinkLinksCountFiles(join(dir, name));
    else if (st.isFile()) count += 1;
  }
  return count;
}

function whenClosed(stream: Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, 5_000);
    stream.once('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** One range (bytes=a-b, a-, -n): [start, end] inclusive; null for the whole file; 'bad' when unusable. */
function parseRange(value: string | undefined, size: number): [number, number] | null | 'bad' {
  if (value == null || value === '') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return 'bad';
  if (m[1] === '') {
    const n = Number(m[2]);
    return n > 0 ? [Math.max(0, size - n), size - 1] : 'bad';
  }
  const start = Number(m[1]);
  if (start >= size || (m[2] !== '' && Number(m[2]) < start)) return 'bad';
  return [start, m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)];
}

function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  if (ascii === name) return `attachment; filename="${name}"`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

function limitsOf(row: PluginRow): { maxFile: number; maxTotal: number } {
  const f = row.files || {};
  const pick = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fallback);
  return { maxFile: pick(f.max_file_bytes, DEFAULT_MAX_FILE_BYTES), maxTotal: pick(f.max_total_bytes, DEFAULT_MAX_TOTAL_BYTES) };
}

function readIfMatch(body: Record<string, unknown>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'if_match') || body.if_match === undefined) return undefined;
  if (body.if_match === null || typeof body.if_match === 'string') return body.if_match;
  throw new PluginFileError(400, 'bad_request', 'if_match must be an etag or null');
}

/** A string: the file must still have that etag; null: there must be no file. */
function checkIfMatch(want: string | null | undefined, current: BigIntStats | null): void {
  if (want === undefined) return;
  const etag = current && current.isFile() ? fileEtag(current) : null;
  if (want === null && etag !== null) throw new PluginFileError(409, 'changed', 'a file is already there', { etag });
  if (want !== null && want !== etag) {
    throw new PluginFileError(409, 'changed', etag ? 'the file changed since it was read' : 'the file was removed', { etag });
  }
}

function uploadGone(): PluginFileError {
  return new PluginFileError(404, 'upload_not_found', 'no such upload (it finished, was stopped or expired)');
}

function busyError(rel: string): PluginFileError {
  return new PluginFileError(409, 'busy', `${rel} is in use by another program`);
}

interface Upload {
  id: string;
  projectId: string;
  plugin: string;
  rel: string;
  size: number;
  ifMatch: string | null | undefined;
  staging: string;
  received: number;
  busy: boolean;
  aborted: boolean;
  lastActive: number;
  /** The chunk request being written, if any. */
  inflight: IncomingMessage | null;
}

interface Place {
  /** The plugin's folder, resolved. */
  root: string;
  /** Where the path really lands. */
  target: string;
  /** Its parts from the plugin's folder, as spelled on disk. */
  parts: string[];
}

type Mode = 'read' | 'list' | 'write' | 'delete';

export class PluginFiles {
  private readonly plugins: () => Promise<PluginRow[]>;
  private readonly projectDirOf: (projectId: string) => string;
  private readonly fs: FsOps;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly activeCases: ((projectId: string, plugin: string) => string[]) | null;
  private readonly uploads = new Map<string, Upload>();
  private readonly locks = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: PluginFilesOptions) {
    this.plugins = opts.plugins;
    this.projectDirOf = opts.projectDir || ((pid) => String(catalogProjectDir(pid)));
    this.fs = {
      rename: (from, to) => fsp.rename(from, to),
      statfs: (path) => fsp.statfs(path),
      createWriteStream: (path, o) => createWriteStream(path, o),
      mkdir: (path, o) => fsp.mkdir(path, o),
      unlink: (path) => fsp.unlink(path),
      rm: (path, o) => fsp.rm(path, o),
      ...opts.fsOps,
    };
    this.now = opts.now || Date.now;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
    this.activeCases = opts.activeCases || null;
  }

  /** A running case's folder is busy (writes inside it; deletes inside, of or above it). */
  private checkBusy(projectId: string, plugin: string, parts: readonly string[], mode: 'write' | 'delete'): void {
    if (!this.activeCases) return;
    let keys: string[] = [];
    try {
      keys = this.activeCases(projectId, plugin) || [];
    } catch {
      keys = [];
    }
    if (keys.length && caseBusy(parts, keys, mode)) throw new PluginFileError(409, 'busy', CASE_BUSY);
  }

  /**
   * Where a path of the plugin's folder really lands (place()'s resolution), as
   * its parts from that folder spelled on disk. Nothing is written.
   */
  async realParts(projectId: string, plugin: string, rel: unknown, mode: 'write' | 'delete' = 'write'): Promise<string[]> {
    if (!validKey(plugin)) throw new PluginFileError(400, 'bad_request', 'invalid plugin key');
    let dir = '';
    try {
      dir = this.projectDirOf(projectId);
    } catch {
      throw new PluginFileError(400, 'bad_request', 'invalid project id');
    }
    const at = await this.place(dir, plugin, relParts(rel, false), mode);
    return at.parts;
  }

  /**
   * A plugin OpenFOAM case's folder: studies/<studyId>/<caseRel> in the plugin's
   * folder, with caseRel's own rules (1 to 8 plain parts, no placeholder), resolved
   * as every file call is. Its real parts stay under the study with at least one
   * part below it.
   */
  async caseFolder(
    projectId: string,
    plugin: string,
    studyId: string,
    caseRel: unknown,
  ): Promise<{ parts: string[]; base: string; dir: string; rel: string }> {
    const { dir } = await this.scope(projectId, plugin);
    if (!STUDY_ID_RE.test(String(studyId || ''))) throw new PluginFileError(400, 'bad_request', 'invalid study id');
    const bad = new PluginFileError(400, 'invalid_path', 'The case folder name is not usable');
    const raw = typeof caseRel === 'string' ? caseRel.replace(/\\/g, '/') : '';
    const parts = raw.split('/');
    if (!raw || parts.length > 8) throw bad;
    for (const p of parts) {
      if (!CASE_PART_RE.test(p) || p === '.' || p === '..' || p.endsWith('.') || PLACEHOLDER_RE.test(p)) throw bad;
    }
    const rel = pluginFileRel(['studies', studyId, ...parts].join('/'), { write: true });
    const at = await this.place(dir, plugin, rel.split('/'), 'write');
    if (at.parts.length < 3 || studyNorm(at.parts[0]) !== 'studies' || studyNorm(at.parts[1]) !== studyNorm(studyId)) throw bad;
    const base = join(dir, 'plugins', plugin);
    return { parts: at.parts, base, dir: join(base, ...at.parts), rel: parts.join('/') };
  }

  /** What the plugin's folder in this project holds, against its quota. */
  async usage(projectId: string, plugin: string): Promise<{ bytes: number; entries: number; maxTotal: number; maxEntries: number }> {
    const { dir, row } = await this.scope(projectId, plugin);
    const root = await nativeResolved(join(dir, 'plugins', plugin));
    const used = await folderUsage(root, this.maxEntries, this.now() - STALE_PART_MS);
    return { bytes: used.bytes, entries: used.entries, maxTotal: limitsOf(row).maxTotal, maxEntries: this.maxEntries };
  }

  /** The project's folder and the plugin's row, or why the call is refused. */
  private async scope(projectId: string, plugin: string): Promise<{ dir: string; row: PluginRow }> {
    if (!validKey(plugin)) throw new PluginFileError(400, 'bad_request', 'invalid plugin key');
    let dir = '';
    try {
      dir = this.projectDirOf(projectId);
    } catch {
      throw new PluginFileError(400, 'bad_request', 'invalid project id');
    }
    let rows: PluginRow[];
    try {
      rows = await this.plugins();
    } catch {
      throw new PluginFileError(503, 'unavailable', 'the plugin list is not available right now');
    }
    const row = rows.find((r) => r.key === plugin);
    // The same rule as the workspace files: only a plugin that is on.
    if (!row || row.status !== 'enabled') throw new PluginFileError(404, 'plugin_off', 'this plugin is not on');
    const marker = await statOrNull(join(dir, 'project.json'));
    if (!marker || !marker.isFile()) throw new PluginFileError(404, 'project_not_found', 'no such project');
    return { dir, row };
  }

  /**
   * Where parts really land. The plugin's folder must be <project>/plugins/<key>
   * itself (no link swapped in), and the target inside it; the rules run again on
   * the resolved parts. A delete does not follow its last part (a link goes, not
   * what it leads to).
   */
  private async place(dir: string, plugin: string, parts: string[], mode: Mode): Promise<Place> {
    const realProject = await nativeResolved(dir);
    const root = await nativeResolved(join(dir, 'plugins', plugin));
    if (!samePath(root, join(realProject, 'plugins', plugin))) {
      throw invalidPath("the plugin's folder in this project is a link");
    }
    const target =
      mode === 'delete'
        ? join(await nativeResolved(join(root, ...parts.slice(0, -1))), parts[parts.length - 1])
        : await nativeResolved(join(root, ...parts));
    const real = partsWithin(root, target);
    if (real === null || (!real.length && mode !== 'list')) throw invalidPath("it leads outside the plugin's folder");
    if (real.some(isReserved)) throw invalidPath('names starting with .magnusim are kept for the app');
    if (mode === 'write') checkWritable(real);
    if (mode === 'delete' && isStudyRecord(real)) throw studyRecordError();
    if (mode === 'delete' && isStudyContainer(real)) throw studyRecordError(STUDY_REMOVE);
    return { root, target, parts: real };
  }

  /** No folder at the target, and no file where one of its folders should be. */
  private async checkFolders(at: Place): Promise<void> {
    let cur = at.root;
    for (let i = -1; i < at.parts.length - 1; i += 1) {
      if (i >= 0) cur = join(cur, at.parts[i]);
      const st = await statOrNull(cur);
      if (!st) return;
      if (!st.isDirectory()) {
        throw new PluginFileError(400, 'is_folder', `${at.parts.slice(0, i + 1).join('/') || 'the folder'} is a file, not a folder`);
      }
    }
    const st = await statOrNull(at.target);
    if (st && st.isDirectory()) throw new PluginFileError(400, 'is_folder', `${at.parts.join('/')} is a folder`);
  }

  /** A file in a study's folder needs the study (it may have been removed meanwhile). */
  private async checkStudy(at: Place): Promise<void> {
    if (at.parts.length < 3 || studyNorm(at.parts[0]) !== 'studies') return;
    const record = await statOrNull(join(at.root, at.parts[0], at.parts[1], 'study.json'));
    if (!record || !record.isFile()) {
      throw new PluginFileError(404, 'study_not_found', 'that study was removed', { study_id: at.parts[1] });
    }
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) || Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((done) => (release = done));
    const tail = before.then(() => mine);
    this.locks.set(key, tail);
    try {
      await before;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /**
   * Changes to one plugin's folder, one at a time: a begin's quota check and its
   * reservation, a commit's checks and rename, a delete. So two begins never both
   * take the last of the quota, and a delete never removes a folder under a commit.
   */
  private inFolder<T>(root: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(`folder:${lockKey(root)}`, fn);
  }

  /**
   * Room for a file of `size` bytes at `at` (in place of `current`): what the folder
   * holds, plus the uploads still open (`self` left out), within the plugin's quota
   * and MAX_ENTRIES. Called in the folder's lock.
   */
  private async checkRoom(at: Place, row: PluginRow, self: Upload, current: BigIntStats | null, sweep: boolean): Promise<void> {
    const { maxTotal } = limitsOf(row);
    const usage = await folderUsage(at.root, this.maxEntries, this.now() - STALE_PART_MS);
    if (sweep) await Promise.all(usage.stale.map((path) => fsp.rm(path, { force: true }).catch(() => undefined)));
    const others = this.openFor(self.projectId, self.plugin).filter((u) => u.id !== self.id);
    if (usage.entries + others.length + (current ? 0 : 1) > this.maxEntries) {
      throw new PluginFileError(413, 'quota', `a plugin may keep ${this.maxEntries} files and folders in a project`, {
        max_entries: this.maxEntries,
      });
    }
    const reserved = others.reduce((n, u) => n + u.size, 0);
    const replaced = current && current.isFile() ? Number(current.size) : 0;
    if (usage.bytes + reserved + self.size - replaced > maxTotal) {
      throw new PluginFileError(413, 'quota', `this plugin's files may take ${mb(maxTotal)} in a project`, {
        limit: maxTotal,
        used: usage.bytes,
        reserved,
      });
    }
  }

  private async freeBytes(path: string): Promise<number> {
    try {
      const st = await this.fs.statfs(path);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private openFor(projectId: string, plugin: string): Upload[] {
    return [...this.uploads.values()].filter((u) => u.projectId === projectId && u.plugin === plugin);
  }

  private uploadFor(id: string, projectId: string, plugin: string): Upload {
    const up = this.uploads.get(String(id || ''));
    // Another project's or plugin's upload gets the same answer as an unknown id.
    if (!up || up.projectId !== projectId || up.plugin !== plugin) throw uploadGone();
    return up;
  }

  private async drop(up: Upload): Promise<void> {
    up.aborted = true;
    this.uploads.delete(up.id);
    if (up.inflight && !up.inflight.destroyed) up.inflight.destroy();
    if (!this.uploads.size) this.stopTimer();
    await fsp.rm(up.staging, { force: true }).catch(() => undefined);
  }

  private async expireIdle(): Promise<void> {
    const now = this.now();
    const idle = [...this.uploads.values()].filter((u) => !u.busy && now - u.lastActive >= UPLOAD_IDLE_MS);
    await Promise.all(idle.map((u) => this.drop(u)));
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.expireIdle(), 30_000);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Staging files older than an hour that no open upload owns (left by a crash). */
  private async sweepStaging(dir: string): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    const cutoff = this.now() - STALE_PART_MS;
    for (const name of names) {
      if (!name.endsWith('.part') || this.uploads.has(name.slice(0, -5))) continue;
      const path = join(dir, name);
      const st = await fsp.lstat(path).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < cutoff) await fsp.rm(path, { force: true }).catch(() => undefined);
    }
  }

  async stat(projectId: string, plugin: string, rel: unknown): Promise<FileInfo | null> {
    const { dir } = await this.scope(projectId, plugin);
    const at = await this.place(dir, plugin, relParts(rel, false), 'read');
    const st = await statOrNull(at.target);
    return st && st.isFile() ? infoOf(at.parts.join('/'), st) : null;
  }

  async list(projectId: string, plugin: string, prefix: unknown): Promise<{ files: FileInfo[]; truncated: boolean }> {
    const { dir } = await this.scope(projectId, plugin);
    const at = await this.place(dir, plugin, relParts(prefix, true), 'list');
    const st = await statOrNull(at.target);
    if (!st) return { files: [], truncated: false };
    if (!st.isDirectory()) throw new PluginFileError(400, 'not_folder', `${at.parts.join('/')} is a file, not a folder`);
    const found: FileInfo[] = [];
    await collectFiles(at.target, at.parts, found);
    found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { files: found.slice(0, LIST_MAX), truncated: found.length > LIST_MAX };
  }

  /** GET/HEAD: the bytes, streamed from one open file (its etag from that handle). */
  async serveRead(ctx: RequestContext): Promise<void> {
    const q = ctx.url.searchParams;
    const plugin = q.get('plugin') || '';
    const { dir } = await this.scope(ctx.scope.projectId, plugin);
    const at = await this.place(dir, plugin, relParts(q.get('rel') || '', false), 'read');
    const notFound = new PluginFileError(404, 'not_found', `${at.parts.join('/')} does not exist`);
    let fh: FileHandle;
    try {
      fh = await fsp.open(at.target, 'r');
    } catch (err) {
      if (MISSING.has(errCode(err)) || errCode(err) === 'EISDIR') throw notFound;
      throw err;
    }
    let handed = false;
    try {
      const st = await fh.stat({ bigint: true });
      if (!st.isFile()) throw notFound;
      const etag = fileEtag(st);
      const size = Number(st.size);
      // Compared as sent, as the uploads compare if_match ("*" is no wildcard here).
      const ifMatch = ctx.req.headers['if-match'];
      if (ifMatch !== undefined && ifMatch !== etag) {
        throw new PluginFileError(409, 'changed', 'the file changed since it was read', { etag });
      }
      const res = ctx.res;
      // Also on a 416: a range of an empty file is refused, and the bridge answers it as empty.
      res.setHeader('ETag', etag);
      res.setHeader('X-Magnusim-File-Size', String(size));
      const range = parseRange(ctx.req.headers.range, size);
      if (range === 'bad') {
        res.setHeader('Content-Range', `bytes */${size}`);
        throw new PluginFileError(416, 'bad_range', 'that byte range is not in the file', { size });
      }
      const [start, end] = range || [0, size - 1];
      res.statusCode = range ? 206 : 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(size ? end - start + 1 : 0));
      res.setHeader('Accept-Ranges', 'bytes');
      if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', attachment(at.parts[at.parts.length - 1]));
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      if (ctx.method === 'HEAD' || !size) {
        res.end();
        return;
      }
      handed = true;
      // A reader that goes away ends the stream, which closes the file.
      await pipeline(fh.createReadStream({ start, end }), res).catch(() => undefined);
    } finally {
      if (!handed) await fh.close().catch(() => undefined);
    }
  }

  async begin(projectId: string, plugin: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.expireIdle();
    const { dir, row } = await this.scope(projectId, plugin);
    const parts = relParts(body.rel, false);
    checkWritable(parts);
    const at = await this.place(dir, plugin, parts, 'write');
    this.checkBusy(projectId, plugin, at.parts, 'write');
    const size = body.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new PluginFileError(400, 'bad_request', 'size must be a whole number of bytes');
    }
    const ifMatch = readIfMatch(body);
    await this.checkFolders(at);
    await this.checkStudy(at);
    const current = await statOrNull(at.target);
    checkIfMatch(ifMatch, current);
    const { maxFile } = limitsOf(row);
    if (size > maxFile) throw new PluginFileError(413, 'too_large', `a file may be ${mb(maxFile)} at most`, { limit: maxFile });
    const id = randomBytes(16).toString('hex');
    const stagingDir = join(at.root, STAGING);
    const up: Upload = {
      id,
      projectId,
      plugin,
      rel: parts.join('/'),
      size,
      ifMatch,
      staging: join(stagingDir, `${id}.part`),
      received: 0,
      busy: true,
      aborted: false,
      lastActive: this.now(),
      inflight: null,
    };
    await this.inFolder(at.root, async () => {
      await this.checkRoom(at, row, up, current, true);
      // One disk for every project: what the open uploads still have to write is spoken for.
      await this.withLock('disk', async () => {
        const owed = [...this.uploads.values()].reduce((n, u) => n + u.size - u.received, 0);
        const free = await this.freeBytes(dir);
        if (size + owed + DISK_SPARE_BYTES > free) {
          throw new PluginFileError(507, 'disk_full', 'there is not enough free disk space for this file', {
            needed: size + owed + DISK_SPARE_BYTES,
            free,
          });
        }
        if (this.openFor(projectId, plugin).length >= MAX_OPEN_UPLOADS) {
          throw new PluginFileError(429, 'too_many_uploads', `a plugin may write ${MAX_OPEN_UPLOADS} files at a time`, {
            limit: MAX_OPEN_UPLOADS,
          });
        }
        // Counted from here on: the checks and this happen in both locks.
        this.uploads.set(id, up);
      });
    });
    try {
      await fsp.mkdir(stagingDir, { recursive: true });
      if (!samePath(await fsp.realpath(stagingDir), stagingDir)) throw invalidPath("the plugin's staging folder is a link");
      await this.sweepStaging(stagingDir);
      await (await fsp.open(up.staging, 'wx')).close();
    } catch (err) {
      this.uploads.delete(id);
      await fsp.rm(up.staging, { force: true }).catch(() => undefined);
      throw err;
    }
    if (up.aborted) {
      await fsp.rm(up.staging, { force: true }).catch(() => undefined);
      throw uploadGone();
    }
    up.busy = false;
    up.lastActive = this.now();
    this.startTimer();
    return { upload: id, chunk_bytes: CHUNK_BYTES, max_chunk_bytes: MAX_CHUNK_BYTES, expires_ms: UPLOAD_IDLE_MS };
  }

  /** PUT: one chunk at the next offset, streamed into the staging file. */
  async chunk(ctx: RequestContext): Promise<number> {
    const q = ctx.url.searchParams;
    const plugin = q.get('plugin') || '';
    await this.expireIdle();
    await this.scope(ctx.scope.projectId, plugin);
    const up = this.uploadFor(ctx.params.upload, ctx.scope.projectId, plugin);
    if (up.busy) throw new PluginFileError(409, 'busy', 'this upload is already taking a chunk');
    const offset = q.get('offset') || '';
    if (!/^\d{1,16}$/.test(offset)) throw new PluginFileError(400, 'bad_request', 'offset must be a byte count');
    if (Number(offset) !== up.received) {
      throw new PluginFileError(409, 'offset', `the next chunk starts at byte ${up.received}`, { received: up.received });
    }
    if (/application\/json/i.test(String(ctx.req.headers['content-type'] || ''))) {
      throw new PluginFileError(400, 'bad_request', 'a chunk is sent as application/octet-stream');
    }
    const bound = Math.min(MAX_CHUNK_BYTES, up.size - up.received);
    const tooLarge = new PluginFileError(413, 'too_large', `this chunk may carry ${bound} bytes at most`, { limit: bound });
    const declared = ctx.req.headers['content-length'];
    if (declared !== undefined) {
      if (!/^\d+$/.test(declared)) throw new PluginFileError(400, 'bad_request', 'invalid Content-Length');
      if (Number(declared) > bound) throw tooLarge;
    }
    up.busy = true;
    up.inflight = ctx.req;
    up.lastActive = this.now();
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > bound) done(tooLarge);
        else done(null, chunk);
      },
    });
    let sink: Writable | null = null;
    try {
      sink = this.fs.createWriteStream(up.staging, { flags: 'r+', start: up.received });
      // The request is not destroyed on a refusal, so the answer still reaches the client.
      await pipeline(ctx.req.iterator({ destroyOnReturn: false }), meter, sink);
      await whenClosed(sink);
    } catch (err) {
      if (sink) await whenClosed(sink);
      up.busy = false;
      up.inflight = null;
      up.lastActive = this.now();
      if (up.aborted) {
        await fsp.rm(up.staging, { force: true }).catch(() => undefined);
        throw uploadGone();
      }
      if (err === tooLarge) {
        await this.drop(up);
        throw tooLarge;
      }
      if (DISK_FULL.has(errCode(err))) {
        await this.drop(up);
        throw new PluginFileError(507, 'disk_full', 'the disk is full', { needed: up.size - up.received, free: await this.freeBytes(dirname(up.staging)) });
      }
      // The client went away mid-chunk (or the write failed): keep what came before it.
      await fsp.truncate(up.staging, up.received).catch(() => undefined);
      throw err;
    }
    up.busy = false;
    up.inflight = null;
    up.lastActive = this.now();
    if (up.aborted) {
      await fsp.rm(up.staging, { force: true }).catch(() => undefined);
      throw uploadGone();
    }
    up.received += seen;
    return up.received;
  }

  /** A rename; a folder on the way that another program removed meanwhile is made again, once. */
  private async moveInto(from: string, at: Place): Promise<void> {
    try {
      await this.fs.rename(from, at.target);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err;
      // Not for a study removed meanwhile: its folder is not made again.
      await this.checkStudy(at);
      await this.fs.mkdir(dirname(at.target), { recursive: true });
      await this.fs.rename(from, at.target);
    }
  }

  /** The staging file becomes the target (checked again, in the plugin folder's lock). */
  async commit(uploadId: string, projectId: string, plugin: string, sha256: unknown): Promise<FileInfo & { sha256: string }> {
    await this.expireIdle();
    const { dir, row } = await this.scope(projectId, plugin);
    if (sha256 != null && (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256))) {
      throw new PluginFileError(400, 'bad_request', 'sha256 must be 64 hex digits');
    }
    const up = this.uploadFor(uploadId, projectId, plugin);
    if (up.busy) throw new PluginFileError(409, 'busy', 'this upload is still taking a chunk');
    if (up.received !== up.size) {
      throw new PluginFileError(409, 'incomplete', `${up.received} of ${up.size} bytes arrived`, { received: up.received, size: up.size });
    }
    up.busy = true;
    up.lastActive = this.now();
    try {
      const digest = await sha256Of(up.staging);
      if (typeof sha256 === 'string' && digest !== sha256.toLowerCase()) {
        throw new PluginFileError(422, 'checksum', 'the file arrived damaged (its checksum differs)', { sha256: digest });
      }
      const parts = up.rel.split('/');
      const first = await this.place(dir, plugin, parts, 'write');
      const file = await this.inFolder(first.root, async () => {
        const at = await this.place(dir, plugin, parts, 'write');
        this.checkBusy(projectId, plugin, at.parts, 'write');
        await this.checkFolders(at);
        await this.checkStudy(at);
        const current = await statOrNull(at.target);
        checkIfMatch(up.ifMatch, current);
        if (up.aborted) throw uploadGone();
        // The plugin's own code or ws.data may have filled the folder since the begin.
        await this.checkRoom(at, row, up, current, false);
        await this.fs.mkdir(dirname(at.target), { recursive: true });
        if (partsWithin(at.root, await fsp.realpath(dirname(at.target))) === null) {
          throw invalidPath("it leads outside the plugin's folder");
        }
        if (!(await withRetries(() => this.moveInto(up.staging, at)))) throw busyError(at.parts.join('/'));
        const info = infoOf(at.parts.join('/'), await fsp.stat(at.target, { bigint: true }));
        // In the lock: a begin never counts these bytes twice, or not at all.
        this.uploads.delete(up.id);
        return info;
      });
      if (!this.uploads.size) this.stopTimer();
      return { ...file, sha256: digest };
    } catch (err) {
      up.busy = false;
      up.lastActive = this.now();
      if (up.aborted && !(err instanceof PluginFileError)) throw uploadGone();
      // A file or folder another program holds: the session stays, so the commit can be tried again.
      if (RETRY_CODES.has(errCode(err))) throw busyError(up.rel);
      // So does an unexpected disk error; a refusal ends the upload.
      if (err instanceof PluginFileError && err.code !== 'busy') await this.drop(up);
      throw err;
    }
  }

  async abort(uploadId: string, projectId: string, plugin: string): Promise<boolean> {
    await this.scope(projectId, plugin);
    const up = this.uploads.get(String(uploadId || ''));
    if (!up || up.projectId !== projectId || up.plugin !== plugin) return false;
    await this.drop(up);
    return true;
  }

  async delete(projectId: string, plugin: string, rel: unknown, recursive: boolean): Promise<number> {
    const { dir } = await this.scope(projectId, plugin);
    const parts = relParts(rel, false);
    if (isStudyRecord(parts)) throw studyRecordError();
    if (isStudyContainer(parts)) throw studyRecordError(STUDY_REMOVE);
    const first = await this.place(dir, plugin, parts, 'delete');
    return this.inFolder(first.root, async () => {
      const at = await this.place(dir, plugin, parts, 'delete');
      this.checkBusy(projectId, plugin, at.parts, 'delete');
      const st = await lstatOrNull(at.target);
      if (!st) return 0;
      const name = at.parts.join('/');
      if (st.isDirectory()) {
        if (!recursive) throw new PluginFileError(400, 'is_folder', `${name} is a folder`);
        // Links inside go first, so removing the folder never reaches through one.
        const count = await unlinkLinksCountFiles(at.target);
        try {
          await this.fs.rm(at.target, { recursive: true, force: true, maxRetries: RETRIES - 1, retryDelay: 50 });
        } catch (err) {
          if (RETRY_CODES.has(errCode(err)) || errCode(err) === 'ENOTEMPTY') throw busyError(name);
          throw err;
        }
        return count;
      }
      // A file, or a link (the link itself goes, never what it leads to).
      if (!(await withRetries(() => this.fs.unlink(at.target)))) throw busyError(name);
      return 1;
    });
  }

  /** The plugin was turned off, reloaded, or its environment is rebuilt or removed. */
  async abortPlugin(key: string): Promise<void> {
    await Promise.all([...this.uploads.values()].filter((u) => u.plugin === key).map((u) => this.drop(u)));
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.uploads.values()].map((u) => this.drop(u)));
  }
}

// ---- routes ----

function sendError(ctx: RequestContext, err: unknown): void {
  const { req, res } = ctx;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // A chunk body left unread: answer, then close the connection.
  const unread = !req.complete;
  if (unread) res.setHeader('Connection', 'close');
  if (err instanceof PluginFileError) {
    ctx.sendJson(err.status, { ok: false, error: err.message, code: err.code, ...err.extra });
  } else {
    const code = errCode(err);
    // No local paths in the answer (it reaches a plugin's frame).
    if (DISK_FULL.has(code)) ctx.sendJson(507, { ok: false, error: 'the disk is full', code: 'disk_full' });
    else if (RETRY_CODES.has(code)) ctx.sendJson(409, { ok: false, error: 'the file is in use by another program', code: 'busy' });
    else ctx.sendJson(500, { ok: false, error: `the file operation failed (${code || 'error'})`, code: 'io_error' });
  }
  if (unread && !req.destroyed) req.resume();
}

function answer(fn: (ctx: RequestContext) => Promise<void>) {
  return async (ctx: RequestContext): Promise<void> => {
    try {
      await fn(ctx);
    } catch (err) {
      sendError(ctx, err);
    }
  };
}

async function jsonBody(ctx: RequestContext): Promise<Record<string, unknown>> {
  try {
    return (await ctx.readJsonBody()) || {};
  } catch (err) {
    const status = (err as { status?: number }).status === 413 ? 413 : 400;
    throw new PluginFileError(status, 'bad_request', 'invalid JSON body');
  }
}

/** A field from the JSON body, else the query. */
function field(ctx: RequestContext, body: Record<string, unknown>, name: string): unknown {
  return body[name] != null ? body[name] : (ctx.url.searchParams.get(name) ?? undefined);
}

/** /api/plugin-files/*: a plugin's own files (for its workspace's bridge; the same-origin check applies). */
export function registerPluginFileRoutes(router: Router, files: PluginFiles): void {
  const own = { underscoreAlias: false };
  const pluginOf = (ctx: RequestContext, body: Record<string, unknown> = {}) => String(field(ctx, body, 'plugin') ?? '');
  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-files/stat',
    answer(async (ctx) => {
      ctx.sendJson(200, { ok: true, file: await files.stat(ctx.scope.projectId, pluginOf(ctx), ctx.url.searchParams.get('rel') || '') });
    }),
    own,
  );
  router.add(
    ['GET', 'HEAD'],
    '/api/plugin-files/list',
    answer(async (ctx) => {
      const listed = await files.list(ctx.scope.projectId, pluginOf(ctx), ctx.url.searchParams.get('prefix') || '');
      ctx.sendJson(200, { ok: true, ...listed });
    }),
    own,
  );
  router.add(['GET', 'HEAD'], '/api/plugin-files/read', answer((ctx) => files.serveRead(ctx)), own);
  router.add(
    'POST',
    '/api/plugin-files/uploads',
    answer(async (ctx) => {
      const body = await jsonBody(ctx);
      const begun = await files.begin(ctx.scope.projectId, pluginOf(ctx, body), { ...body, rel: field(ctx, body, 'rel') });
      ctx.sendJson(201, { ok: true, ...begun });
    }),
    own,
  );
  // The router reads only JSON bodies itself, so this handler owns the request stream.
  router.add(
    'PUT',
    '/api/plugin-files/uploads/:upload',
    answer(async (ctx) => {
      ctx.sendJson(200, { ok: true, received: await files.chunk(ctx) });
    }),
    own,
  );
  router.add(
    'POST',
    '/api/plugin-files/uploads/:upload/commit',
    answer(async (ctx) => {
      const body = await jsonBody(ctx);
      const file = await files.commit(ctx.params.upload, ctx.scope.projectId, pluginOf(ctx, body), body.sha256);
      ctx.sendJson(200, { ok: true, file });
    }),
    own,
  );
  router.add(
    'POST',
    '/api/plugin-files/uploads/:upload/abort',
    answer(async (ctx) => {
      const body = await jsonBody(ctx);
      ctx.sendJson(200, { ok: true, aborted: await files.abort(ctx.params.upload, ctx.scope.projectId, pluginOf(ctx, body)) });
    }),
    own,
  );
  router.add(
    'POST',
    '/api/plugin-files/delete',
    answer(async (ctx) => {
      const body = await jsonBody(ctx);
      const deleted = await files.delete(ctx.scope.projectId, pluginOf(ctx, body), field(ctx, body, 'rel'), body.recursive === true);
      ctx.sendJson(200, { ok: true, deleted });
    }),
    own,
  );
}
