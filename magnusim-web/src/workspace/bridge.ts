/**
 * The workspace bridge, host side (API 1.3).
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
 *
 * Plugin OpenFOAM cases (1.3): compute.* submits a case the page wrote in its
 * study's folder, and follows, stops and lists the study's cases. One event
 * stream per channel carries every followed case; a reconnect's snapshot
 * catches each case up, and an event the frame already has (by seq) is dropped.
 *
 * Linked geometries (1.5): project.linkGeometry sends the study's saved design to
 * /api/plugin-geometry/link and stays pending until the job it started ends, following
 * it on this study's /api/plugin-geometry/events stream (its stages go to the page as
 * `linkProgress`). Link job ids sit in a follow-only set, never in `jobs`: nothing a
 * page can call stops an update. The same stream tells the page when this study's
 * geometry changed (`geometry`), and no other study's page hears it.
 */
import type {
  ComputeJob,
  FileInfo,
  FileWriteResult,
  JobEvent,
  LinkedGeometry,
  LinkResult,
  StudyRecord,
  ThemeInfo,
  UnitSystem,
  WorkspaceContext,
} from '../plugin-sdk/workspace';
import { sendLinkChoice, type LinkChoice, type LinkCopyOutcome, type LinkQuestion } from './linkChoice';

export const HOST_SDK_MAJOR = 1;
export const HOST_API_VERSION = '1.5';
/** A link job's id (gl-<time>-<hex>, scripts/link-store.js LINK_JOB_RE). */
const LINK_JOB_ID = /^gl-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
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
  /**
   * results.openIn3D: show a case's saved frames in the project's viewer. True
   * once the workspace is closing for it; false when the user cancelled or stayed.
   */
  openResults(caseRel: string): Promise<boolean>;
  /** A link this page made committed with something the user must know (lost, returned, split, ...). */
  linkReport?(result: LinkResult): void;
  /**
   * A link this page started (its job, or its answer at once): the host lands on that
   * geometry when the workspace closes (showLinkedGeometry, LINK 6.5).
   */
  linkStarted?(link: { geometryId: string; jobId: string | null; created: boolean }): void;
  /**
   * The host's question (API 1.5, LINK 5.0): the shape changed under simulation setup.
   * The answer, or null when it was dropped (the page is going away, or the job ended
   * another way): the question then stays open and the geometry's row offers "Choose…".
   */
  linkChoice?(question: LinkQuestion, signal: AbortSignal): Promise<LinkChoice | null>;
  /** "Save as new" landed: the new geometry and what its copies came to (the host's report). */
  linkSavedAsNew?(info: { newName: string; oldName: string; copies: LinkCopyOutcome[] | null }): void;
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

/** A plugin case's id (fc-<time>-<6 hex>). */
const CASE_JOB_ID = /^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/;
const CASE_DONE = new Set(['done', 'failed', 'stopped', 'lost']);

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v || v.length > max) throw badParam(what);
  return v;
}

function caseJobId(v: unknown): string {
  if (typeof v !== 'string' || !CASE_JOB_ID.test(v)) throw badParam('jobId');
  return v;
}

function texts(v: unknown, what: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw badParam(what);
  for (const x of v) if (typeof x !== 'string' || !x || x.length > maxLength) throw badParam(what);
  return [...(v as string[])];
}

/** compute.submitOpenFOAM's params as the app's submit body (§9.1 shapes; anything else is dropped). */
export function caseSubmitBody(params: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { case_rel: text(params.caseRel, 'caseRel', 240), app: text(params.app, 'app', 64) };
  if (params.nProcs !== undefined && params.nProcs !== null) {
    const n = params.nProcs;
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 64) throw badParam('nProcs (a whole number from 1 to 64)');
    body.n_procs = n;
  }
  if (params.pre !== undefined && params.pre !== null) {
    if (!Array.isArray(params.pre) || params.pre.length > 16) throw badParam('pre (at most 16 steps)');
    body.pre = params.pre.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badParam('pre (each step an object)');
      const step = raw as Record<string, unknown>;
      const out: Record<string, unknown> = { tool: text(step.tool, 'pre tool', 32) };
      if (step.args !== undefined && step.args !== null) out.args = texts(step.args, 'pre args (at most 4, each at most 120 characters)', 4, 120);
      if (step.parallel !== undefined && step.parallel !== null) {
        if (typeof step.parallel !== 'boolean') throw badParam('pre parallel (true or false)');
        out.parallel = step.parallel;
      }
      return out;
    });
  }
  const res = params.results;
  if (!res || typeof res !== 'object' || Array.isArray(res)) throw badParam('results');
  const r = res as Record<string, unknown>;
  const results: Record<string, unknown> = { kinematicFields: texts(r.kinematicFields, 'results.kinematicFields', 16, 64) };
  if (r.rho !== undefined && r.rho !== null) {
    if (typeof r.rho !== 'number' || !Number.isFinite(r.rho) || r.rho <= 0) throw badParam('results.rho (a number above 0)');
    results.rho = r.rho;
  }
  if (r.frameFields !== undefined && r.frameFields !== null) results.frameFields = texts(r.frameFields, 'results.frameFields', 16, 64);
  body.results = results;
  return body;
}

/** A case's result in the frame's shape (ComputeJob.result), whether the app sent it as the record or the job has it. */
function caseResult(raw: unknown): ComputeJob['result'] {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pick = (camel: string, snake: string) => (r[camel] !== undefined ? r[camel] : r[snake]);
  const saved = pick('savedTimes', 'saved_times');
  const phases = r.phases;
  const last = Number(pick('lastSaved', 'last_saved') ?? NaN);
  const format = pick('writeFormat', 'write_format');
  return {
    savedTimes: Array.isArray(saved) ? (saved as unknown[]).map((t) => Number(t)).filter((t) => Number.isFinite(t)) : [],
    lastSaved: Number.isFinite(last) ? last : null,
    phases: phases && typeof phases === 'object' ? (phases as Record<string, number>) : {},
    writeFormat: typeof format === 'string' ? format : null,
  };
}

/** A case as the frame gets it from compute.status and compute.list. */
function caseJob(job: ComputeJob): ComputeJob {
  return { ...job, result: caseResult(job.result) };
}

/** A link file's fields as the link route takes them (`bad_request` for anything else). */
function linkFileBody(v: unknown, what: string): { rel: string; sha256?: string; etag?: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badParam(`${what} ({rel, sha256} or {rel, etag})`);
  const f = v as Record<string, unknown>;
  const out: { rel: string; sha256?: string; etag?: string } = { rel: text(f.rel, `${what}.rel`, 240) };
  if (f.sha256 !== undefined && f.sha256 !== null) {
    if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) throw badParam(`${what}.sha256 (64 hex digits)`);
    out.sha256 = f.sha256.toLowerCase();
  }
  if (f.etag !== undefined && f.etag !== null) out.etag = text(f.etag, `${what}.etag`, 200);
  if (!!out.sha256 === !!out.etag) throw badParam(`${what} (exactly one of sha256 and etag)`);
  return out;
}

/** project.linkGeometry's params as the link route's body (scope added by the caller). */
export function linkBody(params: Record<string, unknown>): Record<string, unknown> {
  const shape = linkFileBody(params.shape, 'shape');
  const format = (params.shape as Record<string, unknown>).format;
  const body: Record<string, unknown> = { shape: { ...shape, format: typeof format === 'string' ? format : '' } };
  body.face_names = params.faceNames === undefined || params.faceNames === null ? null : linkFileBody(params.faceNames, 'faceNames');
  if (!isCount(params.sourceVersion)) throw badParam('sourceVersion (a whole number)');
  body.source_version = params.sourceVersion;
  const based = params.basedOnRev;
  if (based !== null && based !== undefined && !isCount(based)) throw badParam('basedOnRev (a whole number or null)');
  body.based_on_rev = based ?? null;
  if (params.name !== undefined && params.name !== null) body.name = text(params.name, 'name', 120);
  return body;
}

/** A finished link's result for the page: the job's own, else the minimal one an older record kept. */
function linkResultOf(raw: unknown): LinkResult {
  return raw as LinkResult;
}

/** Something in a link's result the user must be told (proposal 5.14): lost, returned, split, merged, moved far, claimed twice. */
export function linkNeedsReport(r: LinkResult | null | undefined): boolean {
  if (!r) return false;
  const m = r.match || { split: 0, merged: 0, movedFar: 0 };
  return !!(r.lost?.length || r.returned?.length || r.claimedTwice?.length || m.split || m.merged || m.movedFar);
}

/** A link this page is waiting for: where its progress goes, and how it ends. */
interface LinkWait {
  token: string;
  done: (r: LinkResult) => void;
  fail: (e: BridgeError) => void;
  seq: number;
  /** The host's question while it is on screen: aborted when the job ends another way. */
  ask?: AbortController | null;
  /** "Save as new": the old geometry's name, for the report. */
  oldName?: string;
}

/** A followed case: the last seq the frame was given; `held` keeps its events until it is caught up. */
interface FollowedCase {
  seq: number;
  endSent: boolean;
  held: Array<{ seq: number; ev: JobEvent }> | null;
}

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
  /** Link jobs this page started: followed only, never stoppable (API 1.5). */
  readonly linkJobs = new Set<string>();
  /** Links this page waits for, by job id; the study's link stream and whether the page wants `geometry`. */
  private readonly linkWaits = new Map<string, LinkWait>();
  /**
   * False for a caller that cannot ask (L3's scripted exit, askToLeave:false): the host's
   * question is answered "Overwrite" at once, revision 6's update (LINK 5.0, 6.4).
   */
  private interactive = true;
  private linkStream: EventSource | null = null;
  private wantsGeometry = false;
  /** Link jobs whose end the page was told of (`geometry` once per job). */
  private readonly linkEnds = new Set<string>();
  private readonly streams = new Map<string, EventSource>();
  /** The study's plugin cases the frame follows (compute.events), and their one stream. */
  private readonly cases = new Map<string, FollowedCase>();
  private caseStream: EventSource | null = null;
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

  /** Whether a link of this page may show the host's question (false: answer "Overwrite"). */
  setInteractive(on: boolean): void {
    this.interactive = !!on;
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
      case 'project.linkGeometry':
        return this.linkGeometry(params);
      case 'project.linkedGeometry': {
        const r = await api<{ linked: LinkedGeometry | null }>(
          `/api/plugin-geometry/linked?${this.q({ plugin: s.plugin, study_id: s.studyId })}`,
        );
        return r.linked ?? null;
      }
      case 'project.followGeometry':
        this.wantsGeometry = true;
        this.openLinkStream();
        return { ok: true };
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
      case 'compute.submitOpenFOAM': {
        const body = caseSubmitBody(params);
        const r = await api<{ job: ComputeJob; ahead?: number | null; existing?: boolean }>(`/api/plugin-cases/submit?${this.q()}`, {
          body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, ...body },
        });
        return { id: r.job.id, ahead: typeof r.ahead === 'number' ? r.ahead : 0, existing: r.existing === true };
      }
      case 'compute.events': {
        const jobId = caseJobId(params.jobId);
        await this.followCase(jobId);
        return { ok: true };
      }
      case 'compute.stop': {
        const jobId = caseJobId(params.jobId);
        const r = await api<{ job: ComputeJob }>(`/api/plugin-cases/stop?${this.q()}`, {
          body: { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, job_id: jobId, force: params.force === true },
        });
        return { status: r.job.status, stopping: r.job.stopping === true };
      }
      case 'compute.status':
        return caseJob(await this.caseStatus(caseJobId(params.jobId)));
      case 'compute.list': {
        const r = await api<{ jobs: ComputeJob[] }>(`/api/plugin-cases?${this.caseQuery()}`);
        return (r.jobs || []).map(caseJob);
      }
      case 'results.openIn3D': {
        const caseRel = text(params.caseRel, 'caseRel', 240);
        return { opened: (await this.hooks.openResults(caseRel)) === true };
      }
      default:
        throw notAllowed(method ? JSON.stringify(method) : 'an unnamed call');
    }
  }

  /**
   * project.linkGeometry: refused `unsaved` while the page says it has unsaved work (the
   * geometry only ever shows a saved design); else the link route, then the job it
   * started, followed to its end.
   */
  private async linkGeometry(params: Record<string, unknown>): Promise<LinkResult> {
    const s = this.scope;
    if (this.frameDirty) throw new BridgeError('Save the design before linking it: the page has unsaved work.', 'unsaved');
    const token = typeof params.token === 'string' ? params.token.slice(0, 64) : '';
    const body = { project_id: s.projectId, plugin: s.plugin, study_id: s.studyId, ...linkBody(params) };
    // Open the stream first, so the job's first events are not missed.
    this.openLinkStream();
    const epoch = this.epoch;
    const answer = await api<{ result?: LinkResult; job_id?: string; geometry_id?: string; created?: boolean; choosing?: LinkQuestion }>(
      `/api/plugin-geometry/link?${this.q()}`,
      { body },
    );
    if (answer.result) {
      const done = linkResultOf(answer.result);
      if (done.geometryId) this.hooks.linkStarted?.({ geometryId: done.geometryId, jobId: null, created: false });
      // Nothing changed, but the link recorded the design's version: the geometry's row
      // reads the tree again ("Not up to date" goes), as it does when a job ends.
      window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { link: true } }));
      return done;
    }
    const jobId = String(answer.job_id || '');
    if (!LINK_JOB_ID.test(jobId)) throw new BridgeError('The app did not start the link', 'failed');
    if (answer.geometry_id && !answer.choosing) this.hooks.linkStarted?.({ geometryId: String(answer.geometry_id), jobId, created: !!answer.created });
    // A page that closed before the answer came does not ask: the question stays open.
    if (epoch !== this.epoch) throw new BridgeError('the workspace closed', 'failed');
    this.linkJobs.add(jobId);
    const ending = new Promise<LinkResult>((done, fail) => {
      this.linkWaits.set(jobId, { token, done, fail, seq: 0 });
      // It may have ended before the stream heard of it: its status says.
      void api<{ job?: { status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number } }>(
        `/api/plugin-geometry/status?${this.q({ plugin: s.plugin, study_id: s.studyId, job_id: jobId })}`,
      )
        .then((r) => {
          if (r.job) this.onLinkJob(jobId, r.job);
        })
        .catch(() => undefined);
    });
    if (answer.choosing) await this.answerLinkQuestion(jobId, answer.choosing);
    const result = await ending;
    const wait = this.saved.get(jobId);
    this.saved.delete(jobId);
    if (wait && result.created && wait.oldName) {
      try {
        this.hooks.linkSavedAsNew?.({ newName: result.name, oldName: wait.oldName, copies: wait.copies });
      } catch (e) {
        this.hooks.log('link report failed', e);
      }
      return result;
    }
    if (linkNeedsReport(result)) {
      try {
        this.hooks.linkReport?.(result);
      } catch (e) {
        this.hooks.log('link report failed', e);
      }
    }
    return result;
  }

  /** "Save as new" jobs this page waits for: the old geometry's name and the copies' outcome, for the report. */
  private readonly saved = new Map<string, { oldName: string; copies: LinkCopyOutcome[] | null }>();

  /**
   * The host's question for a link this page made (LINK 5.0): the dialog over the
   * workspace (or "Overwrite" at once for a caller that cannot ask), then the answer to
   * the choose route, which only the host calls. "Keep editing" ends the job `cancelled`,
   * which rejects linkGeometry with that code. A dialog dropped unanswered (the page went
   * away, or the job ended another way) sends nothing: the question stays open and the
   * geometry's row offers "Choose…".
   */
  private async answerLinkQuestion(jobId: string, question: LinkQuestion): Promise<void> {
    const s = this.scope;
    const wait = this.linkWaits.get(jobId);
    const ask = new AbortController();
    if (wait) {
      wait.ask = ask;
      wait.oldName = question.geometry.name;
    }
    let picked: LinkChoice | null;
    if (!this.interactive || !this.hooks.linkChoice) picked = { choice: 'overwrite' };
    else picked = await this.hooks.linkChoice(question, ask.signal);
    if (wait) wait.ask = null;
    if (!picked || !this.linkWaits.has(jobId)) return;
    try {
      const chosen = await sendLinkChoice({ projectId: s.projectId, plugin: s.plugin, studyId: s.studyId, jobId }, picked);
      if (picked.choice === 'new') this.saved.set(jobId, { oldName: question.geometry.name, copies: null });
      if (chosen.geometry_id && picked.choice !== 'cancel') {
        this.hooks.linkStarted?.({ geometryId: String(chosen.geometry_id), jobId, created: !!chosen.created });
      }
    } catch (e) {
      const code = String((e as { code?: unknown })?.code || 'failed');
      // Answered in another tab or from the geometry's row: the job's end settles the call.
      if (code === 'not_choosing') return;
      const w = this.linkWaits.get(jobId);
      this.linkWaits.delete(jobId);
      this.linkJobs.delete(jobId);
      w?.fail(new BridgeError((e as Error).message || 'The answer was refused', code));
    }
  }

  /** This study's link stream: one per channel, for the links this page waits for and `geometry`. */
  private openLinkStream(): void {
    if (this.linkStream) return;
    const s = this.scope;
    const es = new EventSource(`/api/plugin-geometry/events?${this.q({ plugin: s.plugin, study_id: s.studyId })}`);
    this.linkStream = es;
    es.addEventListener('snapshot', (e) => {
      try {
        const snap = JSON.parse((e as MessageEvent).data) as { jobs?: Array<{ id: string; status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number }> };
        for (const job of snap.jobs || []) if (job && job.id) this.onLinkJob(job.id, job);
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('link', (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as { job_id?: string; seq?: number; ev?: Record<string, unknown> };
        if (typeof m.job_id === 'string' && m.ev && typeof m.ev === 'object') this.onLinkEvent(m.job_id, Number(m.seq) || 0, m.ev);
      } catch {
        /* not JSON: skip */
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && this.linkStream === es) this.linkStream = null;
    };
  }

  /** A link job's state as the snapshot or its status has it: an ended one settles. */
  private onLinkJob(jobId: string, job: { status?: string; result?: unknown; error?: string | null; code?: string | null; seq?: number; copies?: unknown }): void {
    const status = String(job.status || '');
    if (['queued', 'running', 'choosing'].includes(status)) return;
    this.onLinkEvent(
      jobId,
      Number(job.seq) || 0,
      { event: 'end', status, result: job.result ?? null, error: job.error ?? null, code: job.code ?? null, copies: job.copies ?? null },
      true,
    );
  }

  private onLinkEvent(jobId: string, seq: number, ev: Record<string, unknown>, snapshot = false): void {
    const wait = this.linkWaits.get(jobId);
    if (wait && !snapshot) {
      if (seq && seq <= wait.seq) return;
      if (seq) wait.seq = seq;
    }
    const kind = String(ev.event || '');
    if (kind === 'stage' || kind === 'queued') {
      if (wait && wait.token) {
        const stage = kind === 'queued' ? 'queued' : String(ev.stage || '');
        if (stage) {
          this.push({
            event: 'linkProgress',
            data: {
              token: wait.token,
              stage,
              fraction: typeof ev.fraction === 'number' ? ev.fraction : null,
              ...(typeof ev.label === 'string' ? { label: ev.label } : {}),
              ...(typeof ev.ahead === 'number' ? { ahead: ev.ahead } : {}),
            },
          });
        }
      }
      return;
    }
    if (kind !== 'end') return;
    // The question on screen goes when its job ends another way (superseded, answered elsewhere).
    wait?.ask?.abort();
    const status = String(ev.status || '');
    const result = (ev.result || null) as LinkResult | null;
    const kept = this.saved.get(jobId);
    if (kept && Array.isArray(ev.copies)) kept.copies = ev.copies as LinkCopyOutcome[];
    if (status === 'done' && result && result.change && result.change !== 'none' && !this.linkEnds.has(jobId)) {
      this.linkEnds.add(jobId);
      if (this.wantsGeometry) {
        this.push({ event: 'geometry', data: { geometryId: result.geometryId, rev: result.rev, fromRev: result.fromRev ?? null } });
      }
    }
    if (!wait) return;
    this.linkWaits.delete(jobId);
    this.linkJobs.delete(jobId);
    if (status === 'done' && result) wait.done(linkResultOf(result));
    else wait.fail(new BridgeError(String(ev.error || `The link ended ${status || 'without a result'}`), String(ev.code || status || 'failed')));
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

  /** This study's scope for the plugin-case routes. */
  private caseQuery(extra: Record<string, string> = {}): string {
    return this.q({ plugin: this.scope.plugin, study_id: this.scope.studyId, ...extra });
  }

  /** A case of this study (not_found for any other). */
  private async caseStatus(jobId: string): Promise<ComputeJob> {
    const r = await api<{ job: ComputeJob }>(`/api/plugin-cases/status?${this.caseQuery({ job_id: jobId })}`);
    return r.job;
  }

  /**
   * Follow a case of this study: its events reach the frame from now on, after
   * one catch-up (queued, start and the live points, or end) from the stream's
   * snapshot or from its status, whichever comes first.
   */
  private async followCase(jobId: string): Promise<void> {
    const epoch = this.epoch;
    const known = this.cases.get(jobId);
    if (!known) this.cases.set(jobId, { seq: 0, endSent: false, held: [] });
    this.openCaseStream();
    let job: ComputeJob;
    try {
      job = await this.caseStatus(jobId);
    } catch (err) {
      // Not a case of this study: it is not followed.
      const c = this.cases.get(jobId);
      if (!known && c && c.held) this.cases.delete(jobId);
      throw err;
    }
    if (epoch !== this.epoch) return;
    const c = this.cases.get(jobId);
    if (c && c.held) this.catchUp(jobId, c, job, null);
  }

  /** One stream per channel for every followed case of this study. */
  private openCaseStream(): void {
    if (this.caseStream) return;
    const es = new EventSource(`/api/plugin-cases/events?${this.caseQuery()}`);
    this.caseStream = es;
    es.addEventListener('snapshot', (e) => {
      try {
        this.onSnapshot(JSON.parse((e as MessageEvent).data));
      } catch {
        /* not JSON: skip */
      }
    });
    es.addEventListener('case', (e) => {
      try {
        const m = JSON.parse((e as MessageEvent).data) as { job_id?: unknown; seq?: unknown; ev?: unknown };
        if (typeof m.job_id === 'string' && typeof m.seq === 'number' && m.ev && typeof m.ev === 'object') {
          this.onCaseEvent(m.job_id, m.seq, m.ev as JobEvent);
        }
      } catch {
        /* not JSON: skip */
      }
    });
    es.onerror = () => {
      // The browser reconnects by itself (and the next snapshot catches up); a closed stream is opened again by the next compute.events.
      if (es.readyState === EventSource.CLOSED && this.caseStream === es) this.caseStream = null;
    };
  }

  private onSnapshot(snap: { jobs?: ComputeJob[]; live?: { job_id?: string; points?: unknown[] } | null }): void {
    for (const job of Array.isArray(snap.jobs) ? snap.jobs : []) {
      const c = job && this.cases.get(job.id);
      if (!c) continue;
      if (c.held) {
        this.catchUp(job.id, c, job, snap.live || null);
        continue;
      }
      // Seen before (a reconnect): only an end the frame has not had.
      if (CASE_DONE.has(job.status) && !c.endSent) {
        c.endSent = true;
        this.pushCase(job.id, { event: 'end', status: job.status, error: job.error ?? null, code: job.code ?? null, result: caseResult(job.result) });
      }
      c.seq = Math.max(c.seq, Number(job.seq) || 0);
    }
  }

  /** The frame's first view of a followed case, then the events that came meanwhile (newer ones only). */
  private catchUp(jobId: string, c: FollowedCase, job: ComputeJob, live: { job_id?: string; points?: unknown[] } | null): void {
    const held = c.held || [];
    c.held = null;
    c.seq = Number(job.seq) || 0;
    if (job.status === 'queued') this.pushCase(jobId, { event: 'queued', ahead: job.ahead });
    else if (job.status === 'running') {
      this.pushCase(jobId, { event: 'start' });
      if (live && live.job_id === jobId && Array.isArray(live.points) && live.points.length) {
        this.pushCase(jobId, { event: 'progress', points: live.points });
      }
    } else if (CASE_DONE.has(job.status)) {
      c.endSent = true;
      this.pushCase(jobId, { event: 'end', status: job.status, error: job.error ?? null, code: job.code ?? null, result: caseResult(job.result) });
    }
    for (const h of held.sort((a, b) => a.seq - b.seq)) this.onCaseEvent(jobId, h.seq, h.ev);
  }

  private onCaseEvent(jobId: string, seq: number, ev: JobEvent): void {
    const c = this.cases.get(jobId);
    if (!c) return;
    if (c.held) {
      c.held.push({ seq, ev });
      return;
    }
    if (seq <= c.seq) return;
    c.seq = seq;
    if (ev.event === 'end') {
      if (c.endSent) return;
      c.endSent = true;
      this.pushCase(jobId, { ...ev, result: caseResult(ev.result) });
      return;
    }
    this.pushCase(jobId, ev);
  }

  private pushCase(jobId: string, data: JobEvent): void {
    this.push({ event: 'job', jobId, data });
  }

  /** Close every job stream, abort every open upload and forget unsaved work (the channel ended). */
  close(): void {
    for (const es of this.streams.values()) es.close();
    this.streams.clear();
    this.linkStream?.close();
    this.linkStream = null;
    this.wantsGeometry = false;
    // A link the server accepted goes on (the next page sees it in linkedGeometry);
    // this page load no longer waits for it.
    for (const w of this.linkWaits.values()) {
      w.ask?.abort();
      w.fail(new BridgeError('the workspace closed', 'failed'));
    }
    this.linkWaits.clear();
    this.saved.clear();
    this.linkJobs.clear();
    this.caseStream?.close();
    this.caseStream = null;
    this.cases.clear();
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
