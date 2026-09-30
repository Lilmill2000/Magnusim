/**
 * The workspace bridge, host side (API 1.1).
 *
 * A plugin workspace runs in a sandboxed frame with an opaque origin. It says
 * hello (window.postMessage, only accepted from this frame's window) and gets
 * its context plus a private MessageChannel port; every call comes over that
 * port and is checked against the allowlist below, scoped to this plugin,
 * project and study. Anything else is refused ("not allowed") and logged.
 *
 * After every frame load the host asks the document it talks to whether it is
 * still there (probe/alive); a new document that has not connected (a reload,
 * a navigation) ends the old channel and the job streams it opened.
 */
import type { StudyRecord, ThemeInfo, UnitSystem, WorkspaceContext } from '../plugin-sdk/workspace';

export const HOST_SDK_MAJOR = 1;
export const HOST_API_VERSION = '1.1';
const PROBE_MS = 1500;
const METHOD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/;

export interface BridgeScope {
  plugin: string;
  pluginName: string;
  workspace: string;
  projectId: string;
  projectTitle: string;
  studyId: string;
}

export interface BridgeHooks {
  back(): void;
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

export const THEME: ThemeInfo = { name: 'light', stylesheet: '/plugin-sdk/theme.css' };

async function api<T>(url: string, init?: { body?: unknown; method?: string }): Promise<T> {
  const r = await fetch(url, {
    method: init?.method || (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) {
    const code = r.status === 409 ? 'conflict' : r.status === 404 ? 'not_found' : 'failed';
    throw new BridgeError(String(j.error || `the app answered ${r.status}`), code);
  }
  return j as T;
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
        this.hooks.back();
        return { ok: true };
      default:
        throw notAllowed(method ? JSON.stringify(method) : 'an unnamed call');
    }
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

  /** Close every job stream (the channel ended). */
  close(): void {
    for (const es of this.streams.values()) es.close();
    this.streams.clear();
  }
}

/** Connects one workspace frame to the host: handshake, channel, probe after each load. */
export class WorkspaceBridge {
  private readonly frame: HTMLIFrameElement;
  private readonly calls: WorkspaceCalls;
  private readonly hooks: BridgeHooks;
  // `welcomed` once the frame has its context and port (until then it has not connected).
  private channel: { port: MessagePort; instance: string; welcomed: boolean } | null = null;
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
    const channel = { port: mc.port1, instance, welcomed: false };
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

  private closeChannel(): void {
    if (!this.channel) return;
    try {
      this.channel.port.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.calls.close();
  }
}
