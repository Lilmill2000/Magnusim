/**
 * A plugin's studies and JSON files in a project, for the CAD edition (no Python).
 *
 * The JavaScript copy of the worker's plugin_studies.* and plugin_data.* methods
 * (python/cfddesk/worker/methods.py) over magnusim_sdk.data.PluginData: the same
 * files (projects/<pid>/plugins/<key>/studies/<sid>/study.json and the plugin's
 * JSON files), the same records, revisions, errors and path rules, so a project
 * moves between Magnusim and Magnusim CAD as it is. Golden tests hold both to the
 * same answers (scripts/server/__tests__/cad-edition-studies.test.js).
 *
 * Every call is synchronous: Node runs one at a time, as the worker answers one
 * request at a time, so a revision check and its write cannot interleave.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { PROJECTS_ROOT } from '../../project-isolation.js';
import { removeTreeSync } from '../../remove-tree.js';
import { RpcError } from '../worker.ts';
import { isStudyRecord, MAX_ENTRIES } from '../plugin-files.ts';
import { cadEditionKinds, pluginRow, schemaVersion } from './registry.js';

export const RPC_CONFLICT = -32009;
const NOT_FOUND = -32004;
const INVALID = -32602;
const PLUGIN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STUDY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const KIND_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PLUGIN_DATA_MAX = 8 * 1024 * 1024;
const MB = 1024 * 1024;
const JSON_TEMP_PREFIX = '.magnusim-tmp-';
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** What a study update may not change: the host keeps these (methods.py _STUDY_FIXED). */
const STUDY_FIXED = new Set([
  'id',
  'kind',
  'plugin',
  'plugin_name',
  'plugin_version',
  'schema_version',
  'created_at',
  'updated_at',
  'rev',
  'edits_geometry',
  'geometry_removed',
]);
const RECORD_FIXED = new Set(['id', 'kind', 'plugin', 'created_at', 'rev']);
const STUDY_RECORD_WRITE = "a study's record changes only through the study calls";
const STALE_MESSAGE = 'This study changed in another tab. Reload to continue.';
const READ_ONLY = 'This study was saved by a newer version of the plugin; it opens read-only.';

type Rec = Record<string, unknown>;

function invalid(message: string): RpcError {
  return new RpcError(INVALID, message);
}

/** Python's datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export function nowIso(now = new Date()): string {
  return `${now.toISOString().slice(0, 19)}+00:00`;
}

export function versionTuple(version: string): number[] {
  return String(version || '0')
    .split('.')
    .map((part) => {
      const m = /^\d+/.exec(part);
      return m ? Number(m[0]) : 0;
    });
}

/** Python tuple order: element by element, then the shorter first. */
function versionNewer(a: string, b: string): boolean {
  const x = versionTuple(a);
  const y = versionTuple(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return x.length > y.length;
}

/** Python's json.dumps(doc, indent=2, ensure_ascii=False) + "\n". */
export function pyJson(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Blocks for `ms` without spinning the CPU. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fn, again while Windows says the file is held (a reader, the indexer, antivirus): as
 * web_writes.atomic_write retries os.replace, 8 times, waiting 50 ms more each time.
 */
export function retryLocked(fn: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      const code = String((err as NodeJS.ErrnoException)?.code || '');
      if (!RETRY_CODES.has(code) || attempt >= 7) throw err;
      pause(50 * (attempt + 1));
    }
  }
}

/**
 * Write `text` to `path` whole or not at all: a temp file beside it (`prefix` + random),
 * flushed, then renamed over it with retryLocked. A reader sees the old file or the new one.
 * `makeDirs: false`: the folder must be there (a deleted project is never made again).
 */
export function atomicWriteText(path: string, text: string, { prefix, suffix = '', makeDirs = true }: { prefix: string; suffix?: string; makeDirs?: boolean }): void {
  if (makeDirs) mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `${prefix}${randomBytes(6).toString('hex')}${suffix}`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    retryLocked(() => renameSync(tmp, path));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw err;
  }
}

function atomicWriteJson(path: string, doc: unknown): void {
  atomicWriteText(path, pyJson(doc), { prefix: JSON_TEMP_PREFIX, suffix: '.json' });
}

function readJson(path: string): unknown {
  try {
    if (!statSync(path).isFile()) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isDict(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** worker/paths.py project_dir + methods._require_dir. */
export function requireProjectDir(projectId: unknown): string {
  const pid = String(projectId ?? '').trim();
  if (!pid || pid.includes('/') || pid.includes('\\') || pid === '.' || pid === '..') {
    throw new RpcError(-32000, 'invalid project id');
  }
  const root = join(PROJECTS_ROOT, pid);
  if (!existsSync(join(root, 'project.json')) || !statSync(join(root, 'project.json')).isFile()) {
    throw new RpcError(NOT_FOUND, 'project not found', { project_id: pid });
  }
  return root;
}

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // The deepest part that exists, resolved, plus the rest.
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPath(parent), path.slice(parent.length + 1));
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

class PluginData {
  readonly plugin: string;
  readonly root: string;

  constructor(projectDir: string, plugin: unknown) {
    const key = String(plugin ?? '');
    if (!PLUGIN_KEY_RE.test(key) || key.endsWith('.')) throw invalid(`invalid plugin key: ${pyRepr(plugin)}`);
    this.plugin = key;
    this.root = join(realPath(projectDir), 'plugins', key);
  }

  /** The plugin's folder as it really is: refused when a link swapped in for it points elsewhere. */
  realRoot(): string {
    const real = realPath(this.root);
    if (!samePath(real, this.root)) throw invalid("the plugin's data folder is a link to another folder");
    return real;
  }

  /** A path that passed the path rules, checked again where it really lands. */
  locate(clean: string, write: boolean): { root: string; target: string; parts: string[] } {
    const root = this.realRoot();
    const target = realPath(join(root, ...clean.split('/')));
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || /^[A-Za-z]:/.test(rel)) {
      throw invalid(rel ? "path leaves the plugin's data folder" : "a path inside the plugin's data folder is required");
    }
    const parts = rel.split(sep);
    for (const part of parts) {
      if (part.toLowerCase().startsWith('.magnusim')) {
        throw invalid(`${shown(part)}: names starting with .magnusim are kept for the app`);
      }
    }
    if (write) checkWritable(parts);
    return { root, target, parts };
  }

  studyPath(sid: string): string {
    if (!STUDY_ID_RE.test(String(sid || ''))) throw invalid(`invalid study id: ${pyRepr(sid)}`);
    return join(this.root, 'studies', sid, 'study.json');
  }

  studies(): Rec[] {
    const folder = join(this.root, 'studies');
    let names: string[];
    try {
      names = readdirSync(folder, { withFileTypes: true })
        .filter((d) => d.isDirectory() && STUDY_ID_RE.test(d.name))
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
    const out: Rec[] = [];
    for (const name of names) {
      const rec = readJson(join(folder, name, 'study.json'));
      if (isDict(rec) && String(rec.id ?? '') === name) out.push(rec);
    }
    return out.sort((a, b) => {
      const ka = String(a.created_at ?? '');
      const kb = String(b.created_at ?? '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
  }

  study(sid: string): Rec {
    const rec = readJson(this.studyPath(sid));
    if (!isDict(rec)) throw new RpcError(NOT_FOUND, 'study not found');
    return rec;
  }

  createStudy(kind: string, title: string, meta: { pluginName: string; pluginVersion: string; schemaVersion: number }): Rec {
    if (!KIND_KEY_RE.test(String(kind || ''))) throw invalid(`invalid study kind: ${pyRepr(kind)}`);
    const name = pyStrip(String(title || '')).slice(0, 120);
    if (!name) throw invalid('a study needs a title');
    let sid = `st-${randomBytes(4).toString('hex')}`;
    while (existsSync(this.studyPath(sid))) sid = `st-${randomBytes(4).toString('hex')}`;
    const now = nowIso();
    const rec = {
      id: sid,
      kind,
      title: name,
      schema_version: Math.trunc(meta.schemaVersion),
      rev: 1,
      plugin: this.plugin,
      plugin_name: meta.pluginName || this.plugin,
      plugin_version: meta.pluginVersion || '0.0.0',
      created_at: now,
      updated_at: now,
    };
    atomicWriteJson(this.studyPath(sid), rec);
    return rec;
  }

  updateStudy(sid: string, patch: Rec, rev: unknown): Rec {
    const rec = this.study(sid);
    const current = Math.trunc(Number(rec.rev) || 0);
    if (rev == null || Math.trunc(Number(rev)) !== current) {
      throw new RpcError(RPC_CONFLICT, STALE_MESSAGE, { rev: current });
    }
    for (const [k, v] of Object.entries(patch)) if (!RECORD_FIXED.has(k)) rec[k] = v;
    rec.rev = current + 1;
    rec.updated_at = nowIso();
    atomicWriteJson(this.studyPath(sid), rec);
    return rec;
  }

  deleteStudy(sid: string): void {
    this.study(sid);
    // Node 24's rmSync gives up at the first EPERM: remove-tree.js retries.
    removeTreeSync(join(this.root, 'studies', sid));
  }

  /** (bytes in files, files and folders), as the host's quota counts them. */
  usage(limit = MAX_ENTRIES): { bytes: number; entries: number } {
    const root = this.realRoot();
    let bytes = 0;
    let entries = 0;
    const stack = [root];
    while (stack.length && entries <= limit) {
      let found;
      try {
        found = readdirSync(stack.pop() as string, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of found) {
        if (entry.name.toLowerCase().startsWith('.magnusim')) continue;
        const path = join(entry.parentPath, entry.name);
        let st;
        try {
          st = lstatSync(path);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        entries += 1;
        if (st.isDirectory()) stack.push(path);
        else if (st.isFile()) bytes += st.size;
      }
    }
    return { bytes, entries };
  }
}

/** Python's str.strip() for the whitespace a title may carry. */
function pyStrip(text: string): string {
  return text.replace(/^\s+|\s+$/gu, '');
}

/** Python's repr() of a short str (what its error messages quote). */
function pyRepr(v: unknown): string {
  if (v == null) return 'None';
  const s = String(v);
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function pluginDataFolders(projectDir: string): string[] {
  try {
    return readdirSync(join(projectDir, 'plugins'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && PLUGIN_KEY_RE.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function catalog(projectDir: string, pid: string): { studies: Rec[]; kinds: Rec[] } {
  const kinds: Rec[] = cadEditionKinds();
  const studies: Rec[] = [];
  for (const key of pluginDataFolders(projectDir)) {
    const row = pluginRow(key);
    const enabled = row?.status === 'enabled';
    const pluginKinds = new Map(kinds.filter((k) => enabled && k.plugin === key).map((k) => [String(k.key), k]));
    for (const rec of new PluginData(projectDir, key).studies()) {
      const kind = pluginKinds.get(String(rec.kind ?? ''));
      const listed = row?.status === 'error' ? '' : String(row?.name ?? '');
      const name = [listed, String(rec.plugin_name ?? ''), String(row?.name ?? '')].find((n) => n && n !== key) || key;
      const newer = !!row && enabled && versionNewer(String(rec.plugin_version || '0'), String(row.version));
      const schema = Math.trunc(Number(rec.schema_version) || 1);
      const kindSchema = kind ? schemaVersion(key, String(kind.key)) : null;
      const workspaceTitle = kind
        ? String((row?.workspaces || []).find((w: Rec) => w.key === kind.workspace)?.title ?? '')
        : '';
      const edits = rec.edits_geometry;
      const removed = rec.geometry_removed;
      studies.push({
        id: rec.id,
        plugin: key,
        plugin_name: name,
        kind: rec.kind ?? null,
        kind_title: kind ? kind.title : '',
        icon: kind ? kind.icon : '',
        workspace: kind ? kind.workspace : '',
        workspace_title: workspaceTitle,
        title: rec.title || rec.id,
        rev: Math.trunc(Number(rec.rev) || 0),
        available: !!kind,
        read_only: newer,
        schema_version: schema,
        kind_schema_version: kindSchema,
        needs_migration: !!kind && !newer && kindSchema != null && schema < kindSchema,
        reason: kind ? '' : `Requires the ${name} plugin`,
        scope_key: `p:${pid}/plugin:${key}/study:${String(rec.id)}`,
        edits_geometry: isDict(edits) ? String(edits.id ?? '') : '',
        geometry_removed:
          isDict(removed) && removed.id ? { id: String(removed.id ?? ''), name: String(removed.name ?? '') } : null,
      });
    }
  }
  return { studies, kinds };
}

function studyRow(pid: string, plugin: string, sid: string): Rec {
  const hit = catalog(requireProjectDir(pid), pid).studies.find((r) => r.plugin === plugin && r.id === sid);
  if (!hit) throw new RpcError(NOT_FOUND, 'study not found');
  return hit;
}

function dataFor(pid: string, plugin: unknown): PluginData {
  return new PluginData(requireProjectDir(pid), plugin);
}

function writable(row: Rec): void {
  if (!row.available) throw invalid(String(row.reason));
  if (row.read_only) throw invalid(READ_ONLY);
}

const WHITESPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
const PART_BAD = /[:~<>"|?*\x00-\x1f\x7f]/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3]|conin\$|conout\$)(?:\.|$)/;
const asciiLower = (t: string) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
const shown = (part: string) => pyRepr(part.length <= 40 ? part : `${part.slice(0, 40)}...`);

/** magnusim_sdk.data.data_rel: the path rules, with its words. */
function dataRel(rel: unknown, write: boolean): string {
  if (rel != null && typeof rel !== 'string') throw invalid('a path must be text');
  const text = String(rel ?? '').replace(/\\/g, '/').replace(WHITESPACE, '');
  if (text.length > 1024) throw invalid('that path is longer than 1024 characters');
  if (text.startsWith('/')) throw invalid("a path must be relative to the plugin's folder");
  const parts = text.split('/').filter((part) => part !== '' && part !== '.');
  if (!parts.length) throw invalid("a path inside the plugin's data folder is required");
  for (const part of parts) {
    if (part === '..') throw invalid("'..' is not allowed in a path");
    if (PART_BAD.test(part)) throw invalid(`${shown(part)} has a character that is not allowed in a file name`);
    if (part.endsWith('.') || part.endsWith(' ')) throw invalid(`${shown(part)} ends with a dot or a space`);
    const low = asciiLower(part);
    if (DEVICE.test(low)) throw invalid(`${shown(part)} is a name Windows keeps for a device`);
    if (part.length > 255) throw invalid(`${shown(part)} is longer than 255 characters`);
    if (low.startsWith('.magnusim')) throw invalid(`${shown(part)}: names starting with .magnusim are kept for the app`);
  }
  if (parts.length > 32) throw invalid('that path is more than 32 folders deep');
  const joined = parts.join('/');
  if (joined.length > 240) throw invalid('that path is longer than 240 characters');
  if (write) checkWritable(parts);
  return joined;
}

function checkWritable(parts: string[]): void {
  if (isStudyRecord(parts)) throw invalid(STUDY_RECORD_WRITE);
  const norm = parts.map((part) => part.replace(/[ .]+$/, '').toLowerCase());
  if (norm.length >= 1 && norm.length <= 2 && norm[0] === 'studies') {
    throw invalid('only the study calls write directly in the studies folder');
  }
}

type P = Record<string, unknown>;
const s = (v: unknown) => String(v ?? '').trim();

export const studyMethods: Record<string, (p: P) => unknown> = {
  'plugin_studies.list'(p) {
    const pid = s(p.project_id);
    const { studies, kinds } = catalog(requireProjectDir(pid), pid);
    return { ok: true, project_id: pid, studies, kinds };
  },
  'plugin_studies.create'(p) {
    const pid = s(p.project_id);
    const data = dataFor(pid, p.plugin);
    const { kinds } = catalog(requireProjectDir(pid), pid);
    const kind = String(p.kind ?? '');
    const decl = kinds.find((k) => k.plugin === data.plugin && k.key === kind);
    if (!decl) throw invalid(`${String(p.plugin ?? '')} has no study kind ${pyRepr(kind)} (is the plugin on?)`);
    const row = pluginRow(data.plugin) as Rec;
    const rec = data.createStudy(kind, String(p.title || decl.title), {
      pluginName: String(row.name ?? ''),
      pluginVersion: String(row.version ?? ''),
      schemaVersion: schemaVersion(data.plugin, kind) ?? 1,
    });
    return { ok: true, study: studyRow(pid, data.plugin, String(rec.id)) };
  },
  'plugin_studies.rename'(p) {
    const pid = s(p.project_id);
    const data = dataFor(pid, p.plugin);
    const sid = String(p.study_id ?? '');
    writable(studyRow(pid, data.plugin, sid));
    const name = pyStrip(String(p.title || '')).slice(0, 120);
    if (!name) throw invalid('a study needs a title');
    data.updateStudy(sid, { title: name }, p.rev);
    return { ok: true, study: studyRow(pid, data.plugin, sid) };
  },
  'plugin_studies.delete'(p) {
    const pid = s(p.project_id);
    const sid = String(p.study_id ?? '');
    dataFor(pid, p.plugin).deleteStudy(sid);
    return { ok: true, deleted: sid };
  },
  'plugin_studies.get'(p) {
    const pid = s(p.project_id);
    return { ok: true, study: dataFor(pid, p.plugin).study(String(p.study_id ?? '')) };
  },
  'plugin_studies.update'(p) {
    const pid = s(p.project_id);
    const data = dataFor(pid, p.plugin);
    const sid = String(p.study_id ?? '');
    writable(studyRow(pid, data.plugin, sid));
    if (!isDict(p.patch)) throw invalid('patch must be an object');
    const patch = Object.fromEntries(Object.entries(p.patch).filter(([k]) => !STUDY_FIXED.has(k)));
    return { ok: true, study: data.updateStudy(sid, patch, p.rev) };
  },
  'plugin_data.read'(p) {
    const data = dataFor(s(p.project_id), p.plugin);
    const clean = dataRel(p.rel, false);
    const { target } = data.locate(clean, false);
    const doc = readJson(target);
    return { ok: true, doc: doc === undefined ? null : doc };
  },
  'plugin_data.write'(p) {
    const data = dataFor(s(p.project_id), p.plugin);
    const clean = dataRel(p.rel, true);
    const { root, target, parts } = data.locate(clean, true);
    if (parts.length >= 3 && parts[0].replace(/[ .]+$/, '').toLowerCase() === 'studies') {
      if (!existsSync(join(root, parts[0], parts[1], 'study.json'))) {
        throw new RpcError(NOT_FOUND, 'study not found');
      }
    }
    if (isStudyRecord(parts)) throw invalid(STUDY_RECORD_WRITE);
    const doc = p.doc === undefined ? null : p.doc;
    if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > PLUGIN_DATA_MAX) throw invalid('that file is larger than 8 MB');
    const maxTotal = Number(pluginRow(data.plugin)?.files?.max_total_bytes ?? 512 * MB);
    const size = Buffer.byteLength(pyJson(doc), 'utf8');
    const { bytes, entries } = data.usage();
    let st = null;
    try {
      st = lstatSync(target);
    } catch {
      /* new file */
    }
    if (entries + (st ? 0 : 1) > MAX_ENTRIES) {
      throw invalid(`a plugin may keep ${MAX_ENTRIES} files and folders in a project`);
    }
    const replaced = st && st.isFile() ? st.size : 0;
    if (bytes + size - replaced > maxTotal) {
      throw invalid(`this plugin's files may take ${Math.round(maxTotal / MB)} MB in a project`);
    }
    if (st?.isDirectory()) throw invalid(`${clean} is a folder`);
    atomicWriteJson(target, doc);
    return { ok: true };
  },
};
