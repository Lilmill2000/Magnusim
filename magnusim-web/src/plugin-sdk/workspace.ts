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
export const SDK_VERSION = '1.0.0';

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

export interface Workspace {
  readonly context: WorkspaceContext;
  /** Any bridge call by name; the typed helpers below use it. Rejects with the host's message. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
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
    confirm(opts: ConfirmOptions): Promise<boolean>;
    prompt(opts: PromptOptions): Promise<string | null>;
  };
  nav: {
    /** Close the workspace and go back to the project. */
    back(): Promise<void>;
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

  function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      port.postMessage({ id, method, params });
    });
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
      back: async () => {
        await call('nav.back');
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
