/**
 * What the job tools (compute, wait, jobs) share: the outcome shapes of spec 06 §2.5-2.6,
 * the project a call means (§2.3-2.4), the study it means, and the ui_sync a write emits.
 */
import { randomBytes } from 'node:crypto';
import { uiSync as uiSyncEmitter, uiSyncOrigin, type UiSyncInput } from '../../ui-sync.ts';
import { HostCallError, type Args, type HostCall, type HostCallOptions } from '../host-call.ts';
import { HOST_STALL_MS, type ToolCtx, type ToolOutcome, type ToolRunContext } from '../registry.ts';
import { cleanText, TEXT_CAPS } from '../sanitize.ts';

/** What a write tells the open pages (spec §6.1): uiSync.emit's input, its origin filled in. */
export type JobUiSync = Omit<UiSyncInput, 'by' | 'turn'>;

/** A route call whose answer is JSON (every route the job tools call is). */
export type JsonCall = (id: string, args: Args, o: HostCallOptions) => Promise<Record<string, unknown>>;

/** `call` for JSON answers: a binary one is the app's error (no job route answers bytes). */
export function jsonCall(call: HostCall): JsonCall {
  return async (id, args, o) => {
    const r = await call(id, args, o);
    if (Buffer.isBuffer(r)) throw new HostCallError('bad_answer', 'The app answered with bytes where JSON was expected.');
    return r;
  };
}

export interface JobToolDeps {
  call: JsonCall;
  /** The ui_sync emitter; uiSync.emit (scripts/server/ui-sync.ts) when left out. */
  uiSync?: (e: UiSyncInput) => void;
  /** wait's pause between polls (tests pass a fast one). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** wait polls each job this often (default 2 s). */
  pollMs?: number;
  /** A fresh start id and queue row id (tests pass fixed ones). */
  newId?: () => string;
}

export const NO_PROJECT_HINT = 'Pass project_id from projects, or open one with core__show.';

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
export const text = (v: unknown, max: number = TEXT_CAPS.name): string => (typeof v === 'string' ? cleanText(v, max) : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function fail(code: string, message: string, hint?: string, detail?: unknown): ToolOutcome {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), ...(detail !== undefined ? { detail } : {}) }, summary: cleanText(message, 160) };
}

/** A call the app refused or could not answer, as the model reads it (§2.6). */
export function failedCall(err: unknown, notFoundHint?: string): ToolOutcome {
  if (err instanceof HostCallError) {
    if (err.code === 'geometry_updating') return fail('geometry_updating', err.message, 'The geometry is updating; wait, then try again.');
    if (err.code === 'stale_record') return fail('stale_record', err.message, 'Read it again with read_setup; the person or another window changed it.', err.detail ?? undefined);
    if (err.code !== 'http') return fail(err.code, err.message);
    const status = err.status ?? 0;
    if (status >= 500) return fail('app_error', err.message);
    const own = err.appCode;
    if (status === 404) return fail(own || 'not_found', err.message, notFoundHint);
    if (status === 503 && own === 'geometry_updating') return fail('geometry_updating', err.message, 'The geometry is updating; wait, then try again.');
    return fail(own || (status === 409 ? 'busy' : 'refused'), err.message);
  }
  return fail('failed', 'The app could not be reached.');
}

/** "Mesh 1" as a card and a log quote it: no quote marks of its own. */
export const quoted = (name: string): string => `"${cleanText(name, 80).replace(/["“”]/g, "'")}"`;

/** A start id (/^[a-z0-9-]{8,40}$/, compute-slot.js) or a queue row's id suffix. */
export const freshId = (): string => randomBytes(6).toString('hex');

/**
 * The project a write means (§2.3, §2.4): "" is the turn's; any other must be the turn's
 * too ("Changes go only to the project open in this window").
 */
export function writeProject(input: Record<string, unknown>, ctx: ToolCtx): { ok: true; id: string } | { ok: false; out: ToolOutcome } {
  const asked = str(input.project_id);
  if (!ctx.projectId) {
    return { ok: false, out: fail(asked ? 'not_this_project' : 'no_project', asked ? 'Changes go only to the project open in this window, and none is open.' : 'No project is open in this window.', NO_PROJECT_HINT) };
  }
  if (asked && asked !== ctx.projectId) {
    return {
      ok: false,
      out: fail('not_this_project', 'Changes go only to the project open in this window.', `Open it first: core__show {target:'project', project_id:'${cleanText(asked, 80)}'}, then call this again.`),
    };
  }
  return { ok: true, id: ctx.projectId };
}

/** The project a read means: the given one, else the turn's (null: none). */
export function readProject(input: Record<string, unknown>, ctx: ToolCtx): string | null {
  return str(input.project_id) || ctx.projectId || null;
}

/** The study a call means (§2.3): the given one, else the one shown, else the project's active study. */
export async function studyFor(call: JsonCall, projectId: string, input: Record<string, unknown>, rt: ToolRunContext): Promise<{ id: string; name: string; geometryId: string } | null> {
  const asked = str(input.simulation_id) || rt.ctx.simulationId || '';
  const doc = await call('simulation.get', { project_id: projectId, simulation_id: asked }, { signal: rt.signal, turn: rt.turn });
  const list = rows(doc.simulations);
  const id = asked || text(doc.active_id, 80) || (isRecord(doc.simulation) ? text(doc.simulation.id, 80) : '');
  const row = list.find((s) => String(s.id) === id) ?? (isRecord(doc.simulation) && String(doc.simulation.id) === id ? doc.simulation : null);
  if (!row) return null;
  return { id, name: text(row.name) || id, geometryId: text(row.geometry_id, 80) };
}

/** The project's title for a card ("Wing"), or its id. */
export async function projectTitle(call: JsonCall, projectId: string, rt: { signal: AbortSignal; turn: string | null }): Promise<string> {
  try {
    const doc = await call('project.get', { project_id: projectId }, { signal: rt.signal, turn: rt.turn });
    return (isRecord(doc.project) && text(doc.project.title)) || projectId;
  } catch {
    return projectId;
  }
}

/** Emits the write's ui_sync, its origin from the call (uiSyncOrigin); never fails the call. */
export function emitSync(deps: JobToolDeps, rt: Pick<ToolRunContext, 'turn' | 'ctx'>, e: JobUiSync): void {
  try {
    const input: UiSyncInput = { ...e, ...uiSyncOrigin(rt) };
    if (deps.uiSync) deps.uiSync(input);
    else uiSyncEmitter.emit(input);
  } catch {
    /* the page re-reads on its next poll */
  }
}

/**
 * Keeps a long route call (the hardware check: up to two minutes, no answer meanwhile)
 * inside the tool's stall window: a progress line every 10 s until `work` settles.
 */
export async function withHeartbeat<T>(rt: ToolRunContext, label: string, work: Promise<T>): Promise<T> {
  rt.progress(null, label);
  const timer = setInterval(() => rt.progress(null, label), Math.min(10_000, HOST_STALL_MS / 3));
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
