/**
 * The workspace bridge, frame side: what a plugin's workspace page imports
 * (`import { connect } from '@magnusim/workspace'`, served as
 * `/plugin-sdk/workspace.js`).
 *
 * A workspace runs in a sandboxed frame with an opaque origin: it cannot reach
 * the app's page or its API, has no localStorage, IndexedDB or cookies, and
 * talks to the app only through this bridge. `connect()` says hello to the
 * host, which answers with the context (plugin, project, study, units) and a
 * private MessageChannel port; every call then goes over that port, and the
 * host checks it against an allowlist scoped to this plugin, project and study.
 *
 * Self-contained: no imports, so the host can serve it to any frame.
 */

/** The bridge's version; a host accepts a workspace built for the same major version. */
export const SDK_VERSION = '1.1.0';

/** A project-level study record (plugins/<key>/studies/<sid>/study.json) plus the plugin's own fields. */
export interface StudyRecord {
  id: string;
  kind: string;
  title: string;
  schema_version: number;
  rev: number;
  plugin: string;
  plugin_name: string;
  plugin_version: string;
  created_at: string;
  updated_at: string;
  [field: string]: unknown;
}

export type UnitSystem = 'metric' | 'imperial';

export interface ThemeInfo {
  name: 'light';
  /** The stylesheet with the design tokens and base styles the host serves. */
  stylesheet: string;
}

export interface WorkspaceContext {
  plugin: string;
  workspace: string;
  project: { id: string; title: string };
  study: StudyRecord;
  units: UnitSystem;
  theme: ThemeInfo;
  /**
   * The host's bridge API version ("1.3"). To use a call a later host added,
   * compare it as numbers, major then minor (ws.nav.setDirty needs 1.2), or
   * catch the refusal: an older host rejects a call it does not know with
   * code "not_allowed".
   */
  hostVersion: string;
}

export interface JobEvent {
  event: string;
  [field: string]: unknown;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The confirming button's label ("Delete", "Replace", ...). */
  confirmLabel?: string;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  confirmLabel?: string;
}

/** A file in this plugin's folder of the project. */
export interface FileInfo {
  /** Its path from the plugin's folder ("meshes/wing.stl"), spelled as on disk. */
  rel: string;
  size: number;
  /** When it last changed (ISO-8601, UTC). */
  mtime: string;
  /** Changes whenever the file does; pass it as `ifMatch` to act only on the version you read. */
  etag: string;
}

export interface FileWriteResult extends FileInfo {
  /** The SHA-256 of what was written (hex). */
  sha256: string;
}

export interface FileReadOptions {
  /** The first byte to read (default 0). */
  offset?: number;
  /** How many bytes to read (default: to the end). */
  length?: number;
  /** Read only while the file has this etag (else rejects with code "changed"). */
  ifMatch?: string;
}

export interface FileWriteOptions {
  /** A string: replace only the version with this etag. null: only create a file that is not there yet. */
  ifMatch?: string | null;
  /** The data's SHA-256 (hex): the host checks it before the file is replaced. */
  sha256?: string;
  /** Called after each chunk has arrived, with the bytes sent so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /** Aborting it stops the write; the file is left as it was. */
  signal?: AbortSignal;
}

export interface Workspace {
  readonly context: WorkspaceContext;
  /**
   * Any bridge call by name; the typed helpers below use it. Rejects with the
   * host's message. `transfer` hands buffers over instead of copying them.
   */
  call<T = unknown>(method: string, params?: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
  /** Call a method of this plugin's backend (its service, or its in-process methods). */
  service<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  study: {
    get(): Promise<StudyRecord>;
    /** Save fields of this study; `rev` is the one you read (a stale one is refused). */
    update(patch: Record<string, unknown>, rev: number): Promise<StudyRecord>;
  };
  data: {
    /** A JSON file from this plugin's folder in the project (null when there is none). */
    read<T = unknown>(rel: string): Promise<T | null>;
    write(rel: string, doc: unknown): Promise<void>;
  };
  /**
   * Files of any kind in the same folder (`data` is its JSON view). Paths are
   * relative to it; a study's study.json is read-only here, and files go inside
   * a study's folder (studies/<id>/...), never directly in studies/. Rejections
   * carry `.code`: "changed", "too_large", "quota", "study_record",
   * "study_not_found", "invalid_path", "not_found", "plugin_off", ...
   */
  files: {
    /** The file's bytes, or a range of them (null when there is no such file). */
    read(rel: string, opts?: FileReadOptions): Promise<ArrayBuffer | null>;
    /** As read, as a Blob. */
    readBlob(rel: string, opts?: FileReadOptions): Promise<Blob | null>;
    stat(rel: string): Promise<FileInfo | null>;
    /**
     * Write a whole file: sent in chunks, and it replaces the old one only once
     * every byte has arrived. A string is written as UTF-8. While the write is
     * on its way, leaving the workspace asks the user first.
     */
    write(rel: string, data: ArrayBuffer | ArrayBufferView | Blob | string, opts?: FileWriteOptions): Promise<FileWriteResult>;
    /** Every file under a folder ("": the plugin's folder), at any depth, sorted by rel. */
    list(prefix?: string): Promise<FileInfo[]>;
    /** Delete a file, or a folder with `recursive`; says how many files went. */
    delete(rel: string, opts?: { recursive?: boolean }): Promise<{ deleted: number }>;
  };
  jobs: {
    /** Start one of this plugin's job kinds; returns its id. */
    start(kind: string, params?: Record<string, unknown>): Promise<{ id: string }>;
    /** Follow a job this workspace started; returns a function that stops listening. */
    events(jobId: string, onEvent: (ev: JobEvent) => void): () => void;
    stop(jobId: string): Promise<void>;
  };
  project: {
    info(): Promise<{ id: string; title: string; units: UnitSystem }>;
  };
  ui: {
    toast(message: string, opts?: { kind?: 'info' | 'success' | 'error' }): Promise<void>;
    /**
     * The app's own question dialog. The app shows one dialog at a time, so this
     * one may wait its turn. Resolves false without showing it when the user has
     * chosen to leave the workspace by then.
     */
    confirm(opts: ConfirmOptions): Promise<boolean>;
    /** The app's own name prompt, in turn as confirm: null when cancelled or not shown. */
    prompt(opts: PromptOptions): Promise<string | null>;
  };
  nav: {
    /**
     * Close the workspace and go back to the project. While the page is dirty
     * the app asks the user first, and this resolves false if they choose to
     * stay. When the workspace does close, this page unloads, so the promise
     * may never settle.
     */
    back(): Promise<boolean>;
    /**
     * Mark or clear unsaved work (host 1.2). While dirty, every way out of the
     * workspace asks the user first; closing or reloading the browser tab shows
     * the browser's own prompt. `message` is plain text, at most 200 characters
     * after cleaning, shown in the app's dialog after the plugin's name (never
     * in the browser's prompt). The flag belongs to this page load: a reload of
     * the frame, a closed channel or an approved leave clears it, so do not
     * reload your own page while dirty. Clear it after saving, and before
     * nav.back() to leave without a question.
     */
    setDirty(dirty: boolean, message?: string): Promise<void>;
  };
  /**
   * Live changes the host pushes. Returns a function that stops listening.
   * `study`: the study changed (renamed in the header, or saved): save next with its `rev`.
   */
  on(event: 'units', fn: (units: UnitSystem) => void): () => void;
  on(event: 'theme', fn: (theme: ThemeInfo) => void): () => void;
  on(event: 'study', fn: (study: StudyRecord) => void): () => void;
  /**
   * Start an ES-module worker. A sandboxed frame cannot start a worker from a
   * URL or a module worker from a blob; this starts a classic blob worker that
   * imports your module. Messages posted before your module has loaded are held
   * and handed to it, in order, once it has.
   */
  spawnWorker(url: string | URL): Worker;
}

interface HostReply {
  id?: number;
  result?: unknown;
  error?: { message?: string; code?: string };
  event?: string;
  data?: unknown;
  jobId?: string;
}

const HELLO = 'hello';
/** A commit refused as "busy" (another program has the file open) is tried again this often, this far apart. */
const COMMIT_RETRIES = 3;
const COMMIT_RETRY_MS = 1000;

/** Settles as `p` does, or rejects with `stopped()` as soon as the signal aborts. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, stopped: () => unknown): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(stopped());
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function newInstance(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Say hello to the host and get the workspace's context and bridge.
 * Rejects when the page is not a Magnusim workspace or the host does not answer.
 */
export function connect(opts: { timeoutMs?: number } = {}): Promise<Workspace> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const instance = newInstance();
  return new Promise((resolve, reject) => {
    if (window.parent === window) {
      reject(new Error('Not inside a Magnusim workspace'));
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', onWelcome);
      reject(new Error('The Magnusim host did not answer'));
    }, timeoutMs);
    function onWelcome(event: MessageEvent) {
      const data = event.data as { magnusim?: string; instance?: string; context?: WorkspaceContext } | null;
      if (event.source !== window.parent || !data || data.magnusim !== 'welcome' || data.instance !== instance) return;
      const port = event.ports[0];
      if (!port || !data.context) return;
      clearTimeout(timer);
      window.removeEventListener('message', onWelcome);
      // The host asks after each frame load whether this document is still the one it talks to.
      window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { magnusim?: string; instance?: string } | null;
        if (e.source === window.parent && d && d.magnusim === 'probe' && d.instance === instance) {
          window.parent.postMessage({ magnusim: 'alive', instance }, '*');
        }
      });
      resolve(makeWorkspace(port, data.context));
    }
    window.addEventListener('message', onWelcome);
    window.parent.postMessage({ magnusim: HELLO, sdkVersion: SDK_VERSION, instance }, '*');
  });
}

function makeWorkspace(port: MessagePort, context: WorkspaceContext): Workspace {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const jobListeners = new Map<string, Set<(ev: JobEvent) => void>>();
  const ctx: WorkspaceContext = { ...context };

  port.onmessage = (event: MessageEvent) => {
    const msg = (event.data || {}) as HostReply;
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'The host refused the call'), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.event === 'job' && msg.jobId) {
      for (const fn of jobListeners.get(msg.jobId) || []) fn(msg.data as JobEvent);
      return;
    }
    if (msg.event === 'units') ctx.units = msg.data as UnitSystem;
    if (msg.event === 'theme') ctx.theme = msg.data as ThemeInfo;
    if (msg.event === 'study') ctx.study = msg.data as StudyRecord;
    for (const fn of listeners.get(String(msg.event)) || []) fn(msg.data);
  };
  port.start();

  function call<T = unknown>(method: string, params: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (transfer && transfer.length) port.postMessage({ id, method, params }, transfer);
      else port.postMessage({ id, method, params });
    });
  }

  async function readBlob(rel: string, opts: FileReadOptions = {}): Promise<Blob | null> {
    const r = await call<{ blob: Blob; size: number; etag: string } | null>('files.read', { ...opts, rel });
    return r ? r.blob : null;
  }

  async function writeFile(
    rel: string,
    data: ArrayBuffer | ArrayBufferView | Blob | string,
    opts: FileWriteOptions = {},
  ): Promise<FileWriteResult> {
    let size: number;
    let piece: (start: number, end: number) => [ArrayBuffer | Blob, Transferable[]?];
    if (data instanceof Blob) {
      const blob = data;
      size = blob.size;
      piece = (start, end) => [blob.slice(start, end)];
    } else {
      const bytes =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : null;
      if (!bytes) throw new TypeError('files.write takes an ArrayBuffer, a typed array, a Blob or a string');
      size = bytes.byteLength;
      // Each chunk is a copy that is handed over (not copied again), so the caller's buffer stays as it was.
      piece = (start, end) => {
        const copy = bytes.slice(start, end).buffer;
        return [copy, [copy]];
      };
    }
    const { signal, onProgress } = opts;
    const stopped = () => (signal && signal.reason !== undefined ? signal.reason : new DOMException('The write was aborted', 'AbortError'));
    if (signal?.aborted) throw stopped();
    const begin: Record<string, unknown> = { rel, size };
    if (opts.ifMatch !== undefined) begin.ifMatch = opts.ifMatch;
    const { upload, chunkBytes } = await call<{ upload: string; chunkBytes: number }>('files.write.begin', begin);
    try {
      for (let offset = 0; offset < size;) {
        if (signal?.aborted) throw stopped();
        const end = Math.min(size, offset + chunkBytes);
        const [chunk, transfer] = piece(offset, end);
        await untilAborted(call('files.write.chunk', { upload, offset, data: chunk }, transfer), signal, stopped);
        offset = end;
        onProgress?.(end, size);
      }
      const commit: Record<string, unknown> = { upload };
      if (opts.sha256 !== undefined) commit.sha256 = opts.sha256;
      for (let retries = 0; ; retries++) {
        if (signal?.aborted) throw stopped();
        try {
          // Not cut short by the signal: once sent, the commit may already have replaced the file.
          return await call<FileWriteResult>('files.write.commit', commit);
        } catch (err) {
          if (retries >= COMMIT_RETRIES || (err as { code?: unknown }).code !== 'busy') throw err;
        }
        await untilAborted(new Promise<void>((r) => setTimeout(r, COMMIT_RETRY_MS)), signal, stopped);
      }
    } catch (err) {
      void call('files.write.abort', { upload }).catch(() => undefined);
      throw err;
    }
  }

  const ws: Workspace = {
    get context() {
      return ctx;
    },
    call,
    service: (method, params = {}) => call('service.call', { method, params }),
    study: {
      get: () => call('study.get'),
      update: (patch, rev) => call('study.update', { patch, rev }),
    },
    data: {
      read: (rel) => call('data.read', { rel }),
      write: async (rel, doc) => {
        await call('data.write', { rel, doc });
      },
    },
    files: {
      read: async (rel, opts) => {
        const blob = await readBlob(rel, opts);
        return blob ? blob.arrayBuffer() : null;
      },
      readBlob,
      stat: (rel) => call('files.stat', { rel }),
      write: writeFile,
      list: (prefix = '') => call('files.list', { prefix }),
      delete: (rel, opts = {}) => call('files.delete', { rel, recursive: !!opts.recursive }),
    },
    jobs: {
      start: (kind, params = {}) => call('jobs.start', { kind, params }),
      events(jobId, onEvent) {
        let set = jobListeners.get(jobId);
        if (!set) {
          set = new Set();
          jobListeners.set(jobId, set);
          void call('jobs.events', { jobId }).catch((e: Error) => onEvent({ event: 'error', message: e.message }));
        }
        set.add(onEvent);
        return () => set?.delete(onEvent);
      },
      stop: async (jobId) => {
        await call('jobs.stop', { jobId });
      },
    },
    project: {
      info: () => call('project.info'),
    },
    ui: {
      toast: async (message, opts = {}) => {
        await call('ui.toast', { message, kind: opts.kind || 'info' });
      },
      confirm: (opts) => call('ui.confirm', { ...opts }),
      prompt: (opts) => call('ui.prompt', { ...opts }),
    },
    nav: {
      // A 1.1 host answers { ok: true } without `left`: it always left.
      back: async () => (await call<{ left?: boolean } | null>('nav.back'))?.left !== false,
      setDirty: async (dirty, message) => {
        await call('nav.setDirty', { dirty: dirty === true, message: String(message ?? '') });
      },
    },
    on(event: string, fn: (data: never) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const f = fn as (data: unknown) => void;
      set.add(f);
      return () => set?.delete(f);
    },
    spawnWorker(url: string | URL): Worker {
      const href = new URL(String(url), location.href).href;
      // Messages posted before the module has attached its listener would be lost:
      // hold them until it has loaded, then hand them over in order.
      const boot = [
        'const held = [];',
        'const hold = (e) => { e.stopImmediatePropagation(); held.push(e); };',
        "self.addEventListener('message', hold);",
        `import(${JSON.stringify(href)}).then(() => {`,
        "  self.removeEventListener('message', hold);",
        "  for (const e of held) self.dispatchEvent(new MessageEvent('message', { data: e.data, ports: [...e.ports] }));",
        '}, (e) => { setTimeout(() => { throw e; }); });',
      ].join('\n');
      return new Worker(URL.createObjectURL(new Blob([boot], { type: 'text/javascript' })));
    },
  };
  return ws;
}
