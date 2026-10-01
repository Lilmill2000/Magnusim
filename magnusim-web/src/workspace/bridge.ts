/**
 * The workspace bridge, host side (API 1.2).
 *
 * A plugin workspace runs in a sandboxed frame with an opaque origin. It says
 * hello (window.postMessage, only accepted from this frame's window) and gets
 * its context plus a private MessageChannel port; every call comes over that
 * port and is checked against the allowlist below, scoped to this plugin,
 * project and study. Anything else is refused ("not allowed") and logged.
 *
 * Files in the plugin's folder of the project go to /api/plugin-files as raw
 * bytes: the frame hands over Blobs and ArrayBuffers, never JSON-encoded data.
 *
 * After every frame load the host asks the document it talks to whether it is
 * still there (probe/alive); a new document that has not connected (a reload,
 * a navigation) ends the old channel, the job streams and the uploads it opened.
 *
 * The page has unsaved work while it says so (nav.setDirty) or while one of its
 * uploads is open; the host hears of every change (hooks.setDirty) and asks
 * before any way out. A closed channel is clean again.
 */
import type { FileInfo, FileWriteResult, StudyRecord, ThemeInfo, UnitSystem, WorkspaceContext } from '../plugin-sdk/workspace';

export const HOST_SDK_MAJOR = 1;
export const HOST_API_VERSION = '1.2';
const PROBE_MS = 1500;
const METHOD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
/** The longest unsaved-work message the host shows (after cleaning). */
export const DIRTY_MESSAGE_MAX = 200;
/** What the host shows while an upload is open and the page gave no message of its own. */
const UPLOAD_OPEN = 'A file upload has not finished.';
// C0, DEL and C1 (\p{Cc}), line and paragraph separators, and bidi controls.
const DIRTY_MESSAGE_CONTROLS = /[\p{Cc}\u{2028}\u{2029}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/** A page's unsaved-work message as plain text on one line: no controls, single spaces, at most 200 characters. */
export function cleanDirtyMessage(raw: unknown): string {
  let text = '';
  try {
    text = String(raw ?? '');
  } catch {
    // Not text at all (an object whose toString is no function): no message.
  }
  return text
    .replace(DIRTY_MESSAGE_CONTROLS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIRTY_MESSAGE_MAX);
}

export interface BridgeScope {
  plugin: string;
  pluginName: string;
  workspace: string;
  projectId: string;
  projectTitle: string;
  studyId: string;
}

export interface BridgeHooks {
  /** Leave the workspace for the project; false when the user chose to stay. */
  back(): Promise<boolean>;
  /** The page's unsaved-work state changed (message is '' when clean). */
  setDirty(dirty: boolean, message: string): void;
  connected(): void;
  studyChanged(study: StudyRecord): void;
  /** The study is not in the project any more (deleted in another tab). */
  studyGone(): void;
  toast(message: string, kind: 'info' | 'success' | 'error'): void;
  confirm(opts: { title: string; copy: string; yes: string }): Promise<boolean>;
  prompt(opts: { title: string; label: string; value: string; yes: string }): Promise<string | null>;
  units(): UnitSystem;
  log(message: string, detail?: unknown): void;
}

export class BridgeError extends Error {
  code: string;
  constructor(message: string, code = 'failed') {
    super(message);
    this.code = code;
  }
}

const notAllowed = (what: string) => new BridgeError(`not allowed: ${what}`, 'not_allowed');
const badParam = (what: string) => new BridgeError(`bad parameter: ${what}`, 'bad_request');
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export const THEME: ThemeInfo = { name: 'light', stylesheet: '/plugin-sdk/theme.css' };

/** A refused answer as a BridgeError: the app's own code when it names one, else one from the status. */
async function refusal(r: Response): Promise<BridgeError> {
  const j = (await r.json().catch(() => ({}))) as { error?: string; code?: unknown };
  const code = typeof j.code === 'string' && j.code ? j.code : r.status === 409 ? 'conflict' : r.status === 404 ? 'not_found' : 'failed';
  return new BridgeError(String(j.error || `the app answered ${r.status}`), code);
}

async function api<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const r = await fetch(url, {
    method: init?.method || (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  if (!r.ok) throw await refusal(r);
  return (await r.json().catch(() => ({}))) as T;
}

/** An upload this workspace began: where it writes, and how far it has got. */
interface OpenUpload {
  rel: string;
  size: number;
  chunkBytes: number;
  received: number;
  /** A chunk or the commit is on its way (one at a time). */
  busy: boolean;
}

/**
 * The allowlist: what a workspace may ask the host for, each call scoped to
 * this plugin, project and study. Returns what the frame gets back.
 */
export class WorkspaceCalls {
  readonly scope: BridgeScope;
  private readonly hooks: BridgeHooks;
  /** Jobs this workspace started (the only ones it may follow or stop). */
  readonly jobs = new Set<string>();
  private readonly streams = new Map<string, EventSource>();
  /** Uploads this workspace began (the only ones it may send to, commit or abort). */
  private readonly uploads = new Map<string, OpenUpload>();
  /** Bumped by close(): an upload begun before it is aborted when its answer comes. */
  private epoch = 0;
  /** What the page last said with nav.setDirty (the message only counts while dirty). */
  private frameDirty = false;
  private frameMessage = '';
  /** The unsaved-work state the host was last told. */
  private told = { dirty: false, message: '' };
  private push: (msg: Record<string, unknown>) => void = () => undefined;

  constructor(scope: BridgeScope, hooks: BridgeHooks) {
    this.scope = scope;
    this.hooks = hooks;
  }

  setPush(push: (msg: Record<string, unknown>) => void): void {
    this.push = push;
  }

  private q(extra: Record<string, string> = {}): string {
    return new URLSearchParams({ project_id: this.scope.projectId, ...extra }).toString();
  }

  /**
   * Tell the host when the unsaved-work state changes: dirty while the page
   * says so or an upload is open; the page's own message first, else the upload's.
   * Synchronous, so the host sees it before the page's next call.
   */
  private report(): void {
    const uploading = this.uploads.size > 0;
    const dirty = this.frameDirty || uploading;
    const message = this.frameDirty && this.frameMessage ? this.frameMessage : uploading ? UPLOAD_OPEN : '';
    if (dirty === this.told.dirty && message === this.told.message) return;
    this.told = { dirty, message };
    this.hooks.setDirty(dirty, message);
  }

  async study(): Promise<StudyRecord> {
    const r = await this.onStudy(() =>
      api<{ study: StudyRecord }>(`/api/plugin-studies/get?${this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId })}`),
    );
    return r.study;
  }

  /** A study call that finds no study tells the host (it closes the frame). */
  private async onStudy<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'not_found') this.hooks.studyGone();
      throw err;
    }
  }

  async context(): Promise<WorkspaceContext> {
    return {
      plugin: this.scope.plugin,
      workspace: this.scope.workspace,
      project: { id: this.scope.projectId, title: this.scope.projectTitle },
      study: await this.study(),
      units: this.hooks.units(),
      theme: THEME,
      hostVersion: HOST_API_VERSION,
    };
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.scope;
    switch (method) {
      case 'service.call': {
        const name = String(params.method || '');
        if (params.plugin != null && params.plugin !== s.plugin) throw notAllowed("another plugin's service");
        if (!METHOD_NAME.test(name) || name.split('/').includes('..')) throw notAllowed(`service method ${JSON.stringify(name)}`);
        const body = params.params && typeof params.params === 'object' ? (params.params as Record<string, unknown>) : {};
        return api(`/api/plugin/${encodeURIComponent(s.plugin)}/${name}?${this.q()}`, { body: { ...body, project_id: s.projectId } });
      }
      case 'jobs.start': {
        const kind = String(params.kind || '');
        const jobParams = params.params && typeof params.params === 'object' ? (params.params as Record<string, unknown>) : {};
        const r = await api<{ job: { id: string } }>('/api/jobs', {
          body: { kind, plugin: s.plugin, params: { ...jobParams, project_id: s.projectId } },
        });
        this.jobs.add(r.job.id);
        return { id: r.job.id };
      }
      case 'jobs.events': {
        const jobId = String(params.jobId || '');
        if (!this.jobs.has(jobId)) throw notAllowed('a job this workspace did not start');
        this.follow(jobId);
        return { ok: true };
      }
      case 'jobs.stop': {
        const jobId = String(params.jobId || '');
        if (!this.jobs.has(jobId)) throw notAllowed('a job this workspace did not start');
        await api(`/api/jobs/${encodeURIComponent(jobId)}/stop?${this.q()}`, { method: 'POST', body: {} });
        return { ok: true };
      }
      case 'study.get':
        return this.study();
      case 'study.update': {
        const r = await this.onStudy(() =>
          api<{ study: StudyRecord }>('/api/plugin-studies/update', {
            body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, rev: params.rev, patch: params.patch },
          }),
        );
        this.hooks.studyChanged(r.study);
        return r.study;
      }
      case 'data.read': {
        const r = await api<{ doc: unknown }>('/api/plugin-data/read', {
          body: { project_id: s.projectId, plugin: s.plugin, rel: String(params.rel || '') },
        });
        return r.doc ?? null;
      }
      case 'data.write':
        await api('/api/plugin-data/write', {
          body: { project_id: s.projectId, plugin: s.plugin, rel: String(params.rel || ''), doc: params.doc ?? null },
        });
        return { ok: true };
      case 'files.stat':
      case 'files.list':
      case 'files.read':
      case 'files.write.begin':
      case 'files.write.chunk':
      case 'files.write.commit':
      case 'files.write.abort':
      case 'files.delete':
        if (params.plugin != null && params.plugin !== s.plugin) throw notAllowed("another plugin's files");
        return this.files(method, params);
      case 'project.info':
        return { id: s.projectId, title: s.projectTitle, units: this.hooks.units() };
      case 'prefs.units':
        return this.hooks.units();
      case 'theme':
        return THEME;
      case 'ui.toast': {
        const kind = params.kind === 'success' || params.kind === 'error' ? params.kind : 'info';
        this.hooks.toast(String(params.message || '').slice(0, 300), kind);
        return { ok: true };
      }
      case 'ui.confirm':
        return this.hooks.confirm({
          title: String(params.title || 'Are you sure?'),
          copy: String(params.message || ''),
          yes: String(params.confirmLabel || 'OK'),
        });
      case 'ui.prompt':
        return this.hooks.prompt({
          title: String(params.title || 'Name'),
          label: String(params.label || 'Name'),
          value: String(params.value || ''),
          yes: String(params.confirmLabel || 'Save'),
        });
      case 'nav.back':
        return { ok: true, left: (await this.hooks.back()) === true };
      case 'nav.setDirty': {
        // Both worked out before either is kept.
        const dirty = params.dirty === true;
        const message = dirty ? cleanDirtyMessage(params.message) : '';
        this.frameDirty = dirty;
        this.frameMessage = message;
        this.report();
        return { ok: true };
      }
      default:
        throw notAllowed(method ? JSON.stringify(method) : 'an unnamed call');
    }
  }

  /** Files in this plugin's folder of the project; the app checks every path. */
  private async files(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.scope;
    const rel = String(params.rel || '');
    switch (method) {
      case 'files.stat':
        return this.stat(rel);
      case 'files.list': {
        const prefix = String(params.prefix || '');
        const r = await api<{ files: FileInfo[]; truncated?: boolean }>(`/api/plugin-files/list?${this.q({ plugin: s.plugin, prefix })}`);
        if (r.truncated) {
          throw new BridgeError(
            `more than ${r.files.length} files under ${prefix || "the plugin's folder"}: list a smaller folder`,
            'too_many',
          );
        }
        return r.files;
      }
      case 'files.read':
        return this.read(rel, params);
      case 'files.write.begin': {
        const { size, ifMatch } = params;
        if (!isCount(size)) throw badParam('size');
        if (ifMatch !== undefined && ifMatch !== null && typeof ifMatch !== 'string') throw badParam('ifMatch');
        const epoch = this.epoch;
        const r = await this.onFile(rel, () =>
          api<{ upload: string; chunk_bytes: number }>('/api/plugin-files/uploads', {
            body: { project_id: s.projectId, plugin: s.plugin, rel, size, ...(ifMatch !== undefined ? { if_match: ifMatch } : {}) },
          }),
        );
        if (epoch !== this.epoch) {
          this.dropUpload(r.upload);
          throw new BridgeError('the workspace closed', 'failed');
        }
        this.uploads.set(r.upload, { rel, size, chunkBytes: r.chunk_bytes, received: 0, busy: false });
        this.report();
        return { upload: r.upload, chunkBytes: r.chunk_bytes };
      }
      case 'files.write.chunk': {
        const [id, up] = this.ownUpload(params.upload);
        const { offset, data } = params;
        if (!(data instanceof ArrayBuffer) && !(data instanceof Blob)) throw badParam('data (an ArrayBuffer or a Blob)');
        if (!Number.isSafeInteger(offset)) throw badParam('offset');
        if (up.busy) throw new BridgeError('the last chunk of this upload is still on its way', 'busy');
        if (offset !== up.received) throw new BridgeError(`the next chunk starts at byte ${up.received}`, 'offset');
        const n = data instanceof Blob ? data.size : data.byteLength;
        const room = Math.min(up.chunkBytes, up.size - up.received);
        if (n > room) throw new BridgeError(`this chunk may hold at most ${room} bytes`, 'too_large');
        return this.onUpload(up, async () => {
          const r = await fetch(
            `/api/plugin-files/uploads/${encodeURIComponent(id)}?${this.q({ plugin: s.plugin, offset: String(up.received) })}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: data,
              cache: 'no-store',
            },
          );
          if (!r.ok) throw await refusal(r);
          const j = (await r.json()) as { received: number };
          up.received = j.received;
          return { received: j.received };
        });
      }
      case 'files.write.commit': {
        const [id, up] = this.ownUpload(params.upload);
        const sha = params.sha256;
        if (sha != null && !(typeof sha === 'string' && SHA256_HEX.test(sha))) throw badParam('sha256 (64 hex digits)');
        if (up.busy) throw new BridgeError('the last chunk of this upload is still on its way', 'busy');
        const r = await this.onUpload(up, () =>
          this.onFile(up.rel, () =>
            api<{ file: FileWriteResult }>(`/api/plugin-files/uploads/${encodeURIComponent(id)}/commit`, {
              body: { project_id: s.projectId, plugin: s.plugin, ...(typeof sha === 'string' ? { sha256: sha.toLowerCase() } : {}) },
            }),
          ),
        );
        this.uploads.delete(id);
        this.report();
        return r.file;
      }
      case 'files.write.abort': {
        const [id] = this.ownUpload(params.upload);
        this.uploads.delete(id);
        this.report();
        await api(`/api/plugin-files/uploads/${encodeURIComponent(id)}/abort`, { body: { project_id: s.projectId, plugin: s.plugin } });
        return { ok: true };
      }
      case 'files.delete': {
        const r = await this.onFile(rel, () =>
          api<{ deleted: number }>('/api/plugin-files/delete', {
            body: { project_id: s.projectId, plugin: s.plugin, rel, recursive: params.recursive === true },
          }),
        );
        return { deleted: r.deleted };
      }
      default:
        throw notAllowed(JSON.stringify(method));
    }
  }

  private async stat(rel: string): Promise<FileInfo | null> {
    const r = await api<{ file: FileInfo | null }>(`/api/plugin-files/stat?${this.q({ plugin: this.scope.plugin, rel })}`);
    return r.file ?? null;
  }

  /** A file's bytes (or a range of them) as a Blob, its whole size and its etag; null when it is not there. */
  private async read(rel: string, params: Record<string, unknown>): Promise<{ blob: Blob; size: number; etag: string } | null> {
    const { offset, length, ifMatch } = params;
    if (offset !== undefined && !isCount(offset)) throw badParam('offset');
    if (length !== undefined && !isCount(length)) throw badParam('length');
    if (ifMatch != null && typeof ifMatch !== 'string') throw badParam('ifMatch');
    const from = offset ?? 0;
    if (length === 0) {
      // No byte range asks for nothing: answer from the file's stat.
      const info = await this.stat(rel);
      if (!info) return null;
      if (typeof ifMatch === 'string' && ifMatch !== info.etag) throw new BridgeError(`${rel} changed since it was read`, 'changed');
      return { blob: new Blob([]), size: info.size, etag: info.etag };
    }
    const headers: Record<string, string> = {};
    if (length !== undefined) headers.Range = `bytes=${from}-${from + length - 1}`;
    else if (from > 0) headers.Range = `bytes=${from}-`;
    if (typeof ifMatch === 'string') headers['If-Match'] = ifMatch;
    const r = await fetch(`/api/plugin-files/read?${this.q({ plugin: this.scope.plugin, rel })}`, { headers, cache: 'no-store' });
    // No byte range fits an empty file: from its start, that is all of it (as without a range).
    if (r.status === 416 && from === 0 && r.headers.get('X-Magnusim-File-Size') === '0') {
      return { blob: new Blob([]), size: 0, etag: r.headers.get('ETag') || '' };
    }
    if (!r.ok) {
      const err = await refusal(r);
      if (err.code === 'not_found') return null;
      throw err;
    }
    const blob = await r.blob();
    const size = Number(r.headers.get('X-Magnusim-File-Size') ?? NaN);
    return { blob, size: Number.isFinite(size) ? size : blob.size, etag: r.headers.get('ETag') || '' };
  }

  private ownUpload(upload: unknown): [string, OpenUpload] {
    const id = typeof upload === 'string' ? upload : '';
    const up = this.uploads.get(id);
    if (!up) throw notAllowed('an upload this workspace did not begin');
    return [id, up];
  }

  /**
   * One call at a time per upload. A failed one keeps the upload listed until
   * the frame aborts it (or the channel ends), so that abort is not refused.
   */
  private async onUpload<T>(up: OpenUpload, run: () => Promise<T>): Promise<T> {
    up.busy = true;
    try {
      return await run();
    } finally {
      up.busy = false;
    }
  }

  /** A file call under this study's folder that finds the study gone tells the host (it closes the frame). */
  private async onFile<T>(rel: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof BridgeError && err.code === 'study_not_found' && this.underStudy(rel)) this.hooks.studyGone();
      throw err;
    }
  }

  private underStudy(rel: string): boolean {
    const parts = rel
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((p) => p.replace(/[ .]+$/, '').toLowerCase())
      .filter(Boolean);
    return parts.length >= 3 && parts[0] === 'studies' && parts[1] === this.scope.studyId.toLowerCase();
  }

  /** Abort an upload without waiting (keepalive: it still goes when the page is closing). */
  private dropUpload(id: string): void {
    void fetch(`/api/plugin-files/uploads/${encodeURIComponent(id)}/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: this.scope.projectId, plugin: this.scope.plugin }),
      cache: 'no-store',
      keepalive: true,
    }).catch(() => undefined);
  }

  /** Forward a job's events to the frame until it ends (one stream per job). */
  private follow(jobId: string): void {
    if (this.streams.has(jobId)) return;
    const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events?${this.q()}`);
    this.streams.set(jobId, es);
    es.addEventListener('event', (e) => {
      try {
        this.push({ event: 'job', jobId, data: JSON.parse((e as MessageEvent).data) });
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('end', (e) => {
      try {
        const rec = JSON.parse((e as MessageEvent).data) as { status?: string; error?: string | null };
        this.push({ event: 'job', jobId, data: { event: 'end', status: rec.status, error: rec.error ?? null } });
      } catch {
        this.push({ event: 'job', jobId, data: { event: 'end' } });
      }
      es.close();
      this.streams.delete(jobId);
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) this.streams.delete(jobId);
    };
  }

  /** Close every job stream, abort every open upload and forget unsaved work (the channel ended). */
  close(): void {
    for (const es of this.streams.values()) es.close();
    this.streams.clear();
    for (const id of this.uploads.keys()) this.dropUpload(id);
    this.uploads.clear();
    this.epoch++;
    this.frameDirty = false;
    this.frameMessage = '';
    this.report();
  }
}

/** Connects one workspace frame to the host: handshake, channel, probe after each load. */
export class WorkspaceBridge {
  private readonly frame: HTMLIFrameElement;
  private readonly calls: WorkspaceCalls;
  private readonly hooks: BridgeHooks;
  // `welcomed` once the frame has its context and port (until then it has not connected);
  // `ended` aborts when the channel ends.
  private channel: { port: MessagePort; instance: string; welcomed: boolean; ended: AbortController } | null = null;
  private alive = '';

  constructor(frame: HTMLIFrameElement, calls: WorkspaceCalls, hooks: BridgeHooks) {
    this.frame = frame;
    this.calls = calls;
    this.hooks = hooks;
  }

  attach(): () => void {
    window.addEventListener('message', this.onMessage);
    this.frame.addEventListener('load', this.onLoad);
    window.addEventListener('cfd:units', this.onUnits);
    return () => {
      window.removeEventListener('message', this.onMessage);
      this.frame.removeEventListener('load', this.onLoad);
      window.removeEventListener('cfd:units', this.onUnits);
      this.closeChannel();
    };
  }

  connected(): boolean {
    return !!this.channel && this.channel.welcomed;
  }

  /**
   * Ends with the current channel (a new hello, a failed probe, detach): what
   * that page load asked for, a dialog of its own, is moot then. Null when there is none.
   */
  channelSignal(): AbortSignal | null {
    return this.channel ? this.channel.ended.signal : null;
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame.contentWindow) return;
    const data = event.data as { magnusim?: string; sdkVersion?: string; instance?: string } | null;
    if (!data || typeof data !== 'object') return;
    if (data.magnusim === 'hello') void this.hello(data);
    else if (data.magnusim === 'alive' && typeof data.instance === 'string') this.alive = data.instance;
  };

  private async hello(data: { sdkVersion?: string; instance?: string }): Promise<void> {
    const major = Number(String(data.sdkVersion || '').split('.')[0]);
    if (major !== HOST_SDK_MAJOR || typeof data.instance !== 'string' || !data.instance) {
      this.hooks.log('workspace hello refused (SDK version)', data);
      return;
    }
    this.closeChannel();
    const mc = new MessageChannel();
    const instance = data.instance;
    const channel = { port: mc.port1, instance, welcomed: false, ended: new AbortController() };
    this.channel = channel;
    mc.port1.onmessage = (e) => void this.request(mc.port1, e.data);
    this.calls.setPush((msg) => mc.port1.postMessage(msg));
    let context: WorkspaceContext;
    try {
      context = await this.calls.context();
    } catch (err) {
      this.hooks.log('workspace context failed', err);
      this.closeChannel();
      return;
    }
    const win = this.frame.contentWindow;
    if (!win || this.channel !== channel) return;
    // The frame's origin is opaque, so no target origin names it; only this window gets the port.
    win.postMessage({ magnusim: 'welcome', instance, context }, '*', [mc.port2]);
    channel.welcomed = true;
    this.hooks.connected();
  }

  private async request(port: MessagePort, msg: unknown): Promise<void> {
    const m = (msg || {}) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof m.id !== 'number') return;
    const method = String(m.method || '');
    const params = m.params && typeof m.params === 'object' ? (m.params as Record<string, unknown>) : {};
    try {
      port.postMessage({ id: m.id, result: await this.calls.handle(method, params) });
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError(err instanceof Error ? err.message : String(err));
      if (e.code === 'not_allowed') this.hooks.log(`workspace ${this.calls.scope.plugin}: ${e.message}`, params);
      port.postMessage({ id: m.id, error: { message: e.message, code: e.code } });
    }
  }

  private onLoad = (): void => {
    const current = this.channel;
    if (!current) return;
    this.alive = '';
    this.frame.contentWindow?.postMessage({ magnusim: 'probe', instance: current.instance }, '*');
    setTimeout(() => {
      if (this.channel === current && this.alive !== current.instance) this.closeChannel();
    }, PROBE_MS);
  };

  /**
   * The study as the host now has it (a rename in the header, a save): the frame
   * keeps saving with its current rev instead of being refused as stale.
   */
  pushStudy(study: StudyRecord): void {
    this.channel?.port.postMessage({ event: 'study', data: study });
  }

  private onUnits = (): void => {
    this.channel?.port.postMessage({ event: 'units', data: this.hooks.units() });
  };

  /** End the channel (a new hello, a failed probe, detach): its streams and uploads go, and a dirty page is clean again. */
  private closeChannel(): void {
    const channel = this.channel;
    if (!channel) return;
    try {
      channel.port.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.calls.close();
    channel.ended.abort();
  }
}
