/**
 * W28 Media — screenshots and screen recordings saved per run (Results) or per
 * mesh, under projects/<project>/media/<owner>/ with an index.json sidecar.
 *
 *   GET    /api/media/list?project_id=&owner=run-<id>|mesh-<id>
 *   POST   /api/media/upload?project_id=&owner=&kind=screenshot|recording&name=&ext=png|mp4|webm
 *          (raw binary body; optional &width=&height=&duration=&meta=<json>)
 *   GET    /api/media/file?project_id=&owner=&id=            → the bytes (inline)
 *   GET    /api/media/file?...&download=1                     → attachment
 *   POST   /api/media/delete { project_id, owner, id }
 *   POST   /api/media/rename { project_id, owner, id, name }
 */
import { safeProjectPath, pathIsWithin } from './safe-path.js';
import { readBinaryBody } from './server/http.ts';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  createReadStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const INCREMENT = 'W28';
const MAX_BYTES = 256 * 1024 * 1024; // Bound per-request memory for buffered recordings.
const MAX_ITEMS = 500;

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function safeId(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(s) ? s : null;
}

function activeProjectId() {
  try {
    const raw = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return raw && (raw.project_id || raw.id || raw.active) ? String(raw.project_id || raw.id || raw.active) : null;
  } catch {
    return null;
  }
}

function resolveProjectId(u) {
  const q = u.searchParams.get('project_id') ?? u.searchParams.get('project');
  return q !== null ? safeId(q) : safeId(activeProjectId());
}

function mediaDir(projectId, owner) {
  const project = safeProjectPath(PROJECTS_ROOT, projectId);
  const dir = safeProjectPath(join(project, 'media'), owner);
  if (!pathIsWithin(dir, project)) throw Object.assign(new Error('media outside project'), { status: 400 });
  return dir;
}

function indexPath(projectId, owner) {
  return join(mediaDir(projectId, owner), 'index.json');
}

function readIndex(projectId, owner) {
  const p = indexPath(projectId, owner);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw.items) ? raw.items : [];
    // Drop entries whose file vanished.
    const dir = mediaDir(projectId, owner);
    return items.filter((it) => it && safeId(it.id) && safeId(it.file) && pathIsWithin(join(dir, it.file), dir) && existsSync(join(dir, it.file)));
  } catch {
    return [];
  }
}

function writeIndex(projectId, owner, items) {
  const dir = mediaDir(projectId, owner);
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath(projectId, owner), JSON.stringify({ items, increment: INCREMENT }, null, 2));
}

function cleanName(name, fallback) {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) s = fallback;
  return s.slice(0, 120);
}

function newId() {
  return randomBytes(4).toString('hex');
}

function publicItem(projectId, owner, it) {
  const q = `project_id=${encodeURIComponent(projectId)}&owner=${encodeURIComponent(owner)}&id=${encodeURIComponent(it.id)}`;
  return {
    ...it,
    url: `/api/media/file?${q}`,
    download_url: `/api/media/file?${q}&download=1`,
  };
}

function listBody(projectId, owner) {
  const items = readIndex(projectId, owner)
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return {
    ok: true,
    increment: INCREMENT,
    project_id: projectId,
    owner,
    items: items.map((it) => publicItem(projectId, owner, it)),
  };
}

/**
 * Vite middleware handler for /api/media/*. Returns false when not handled.
 */
export async function handleW28Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;
  if (parts[0] !== 'api' || parts[1] !== 'media') return false;
  const action = parts[2] || '';

  if (action === 'list' && (req.method === 'GET' || req.method === 'HEAD')) {
    const projectId = resolveProjectId(u);
    const owner = safeId(u.searchParams.get('owner'));
    if (!projectId || !owner) return sendJson(res, 400, { error: 'project_id and owner required' });
    return sendJson(res, 200, listBody(projectId, owner));
  }

  if (action === 'file' && (req.method === 'GET' || req.method === 'HEAD')) {
    const projectId = resolveProjectId(u);
    const owner = safeId(u.searchParams.get('owner'));
    const id = safeId(u.searchParams.get('id'));
    if (!projectId || !owner || !id) return sendJson(res, 400, { error: 'project_id, owner, id required' });
    const it = readIndex(projectId, owner).find((x) => x.id === id);
    if (!it) return sendJson(res, 404, { error: 'media not found', id });
    const full = join(mediaDir(projectId, owner), it.file);
    const st = statSync(full);
    const ext = String(it.ext || '').toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Accept-Ranges', 'bytes');
    const downloadName = `${cleanName(it.name, it.id)}.${ext}`;
    res.setHeader(
      'Content-Disposition',
      `${u.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${downloadName.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
    );
    // Range support so <video> can seek.
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range) && st.size > 0) {
      const [a, b] = range.slice(6).split('-');
      const start = a ? Number(a) : Math.max(0, st.size - Number(b));
      const end = a && b ? Math.min(Number(b), st.size - 1) : st.size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < st.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        if (req.method === 'HEAD') return res.end();
        createReadStream(full, { start, end }).pipe(res);
        return true;
      }
    }
    if (range) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${st.size}`);
      res.setHeader('Content-Length', '0');
      return res.end();
    }
    if (req.method === 'HEAD') return res.end();
    createReadStream(full).pipe(res);
    return true;
  }

  if (action === 'upload' && req.method === 'POST') {
    const projectId = resolveProjectId(u);
    const owner = safeId(u.searchParams.get('owner'));
    const kind = u.searchParams.get('kind') === 'recording' ? 'recording' : 'screenshot';
    const ext = String(u.searchParams.get('ext') || (kind === 'recording' ? 'webm' : 'png')).toLowerCase();
    if (!projectId || !owner) return sendJson(res, 400, { error: 'project_id and owner required' });
    if (!MIME[ext]) return sendJson(res, 400, { error: `unsupported extension ${ext}` });
    let buf;
    try {
      buf = await readBinaryBody(req, MAX_BYTES);
    } catch (e) {
      return sendJson(res, 413, { error: 'upload failed', detail: String(e) });
    }
    if (!buf.length) return sendJson(res, 400, { error: 'empty body' });
    const items = readIndex(projectId, owner);
    if (items.length >= MAX_ITEMS) return sendJson(res, 409, { error: `too many items (max ${MAX_ITEMS})` });
    const id = newId();
    const name = cleanName(u.searchParams.get('name'), `${kind}-${id}`);
    const file = `${id}.${ext}`;
    const dir = mediaDir(projectId, owner);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), buf);
    let meta = null;
    try {
      const m = u.searchParams.get('meta');
      if (m) meta = JSON.parse(m);
    } catch {
      meta = null;
    }
    const num = (k) => {
      const v = Number(u.searchParams.get(k));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const item = {
      id,
      kind,
      name,
      ext,
      file,
      bytes: buf.length,
      width: num('width'),
      height: num('height'),
      duration_s: num('duration'),
      created_at: new Date().toISOString(),
      meta,
    };
    items.push(item);
    writeIndex(projectId, owner, items);
    return sendJson(res, 200, { ok: true, increment: INCREMENT, item: publicItem(projectId, owner, item), count: items.length });
  }

  if ((action === 'delete' || action === 'rename') && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
    }
    const projectId = body.project_id !== undefined && body.project_id !== null ? safeId(body.project_id) : safeId(activeProjectId());
    const owner = safeId(body.owner);
    const id = safeId(body.id);
    if (!projectId || !owner || !id) return sendJson(res, 400, { error: 'project_id, owner, id required' });
    const items = readIndex(projectId, owner);
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return sendJson(res, 404, { error: 'media not found', id });
    if (action === 'delete') {
      const full = join(mediaDir(projectId, owner), items[idx].file);
      try {
        rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
      items.splice(idx, 1);
      writeIndex(projectId, owner, items);
      return sendJson(res, 200, { ok: true, increment: INCREMENT, deleted: id, count: items.length });
    }
    items[idx].name = cleanName(body.name, items[idx].name);
    writeIndex(projectId, owner, items);
    return sendJson(res, 200, { ok: true, increment: INCREMENT, item: publicItem(projectId, owner, items[idx]) });
  }

  return sendJson(res, 404, { error: `unknown media route ${u.pathname}` });
}
