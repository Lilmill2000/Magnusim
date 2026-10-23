/**
 * The Assistant's job ids and how each is followed (spec 06 §8.1). There is no single job
 * id in the app, so an id names what runs, and its state is read from the routes that
 * already serve the page; no job map on the server, and an id survives a restart.
 *
 *   mesh.<mesh_id>    the compute queue (live, or a queued row) and the mesh's record
 *   solve.<run_id>    the compute queue and the run's status
 *   export.<job-…>    GET /api/results/export-vtk/:id (done: a Download for the person)
 *   link.<gl-…>       GET /api/plugin-geometry/status (its plugin and study from the hint)
 *   env.<key>         GET /api/plugins/:key/env
 *   hw.check          the hardware check (the compute call returns its result)
 *
 * Every answer is built from named fields: no path, pid or case folder reaches the model.
 */
import { HostCallError } from '../host-call.ts';
import { cleanText, TEXT_CAPS } from '../sanitize.ts';
import type { JsonCall } from './job-common.ts';
import { jobHint, type StartedJob } from './turn-jobs.ts';

export type JobKind = 'mesh' | 'solve' | 'export' | 'link' | 'env' | 'hw';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'cancelled' | 'unknown';

export interface JobRef {
  kind: JobKind;
  id: string;
  job_id: string;
}

/** What wait reports of one job (spec §4.13). */
export interface JobState {
  job_id: string;
  kind: JobKind;
  name: string;
  status: JobStatus;
  position: number;
  progress: { fraction: number | null; label: string };
  result: Record<string, unknown> | null;
  error: string;
  /** A link job waits for the person's answer to its question. */
  waiting?: boolean;
  /** A finished export: the file the person can save (never sent to the model). */
  download?: { name: string; bytes: number | null; href: string };
}

export const ENDED: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'stopped', 'cancelled', 'unknown']);
const ID = /^[A-Za-z0-9._-]{1,96}$/;

/** A job id, or null when it is not one. */
export function parseJobId(raw: unknown): JobRef | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === 'hw.check') return { kind: 'hw', id: 'check', job_id: text };
  const m = /^(mesh|solve|export|link|env)\.(.+)$/.exec(text);
  if (!m || !ID.test(m[2])) return null;
  if (m[1] === 'export' && !/^job-/.test(m[2])) return null;
  if (m[1] === 'link' && !/^gl-/.test(m[2])) return null;
  return { kind: m[1] as JobKind, id: m[2], job_id: text };
}

export const jobIdOf = (kind: Exclude<JobKind, 'hw'>, id: string): string => `${kind}.${id}`;

export interface FollowContext {
  call: JsonCall;
  signal?: AbortSignal;
  turn: string | null;
  /** The turn's study, a hint for a mesh or run named by its id alone. */
  simulationId: string | null;
}

const text = (v: unknown, max: number = TEXT_CAPS.name) => (typeof v === 'string' ? cleanText(v, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** Words for a mesher's stage key, as the panel shows the common ones. */
export function meshStageWords(stage: unknown): string {
  const s = String(stage ?? '').toLowerCase();
  if (!s || s === 'starting' || s === 'running') return 'starting';
  if (s.startsWith('load_step') || s === 'step_loaded') return 'reading the geometry';
  if (s === 'prepare_input') return 'building the mesh input';
  if (s.includes('surface')) return 'meshing the surface';
  if (s.includes('snappy') || s.includes('snap')) return 'snapping the mesh to the surface';
  if (s === 'gmsh' || s.includes('volume') || s.includes('hex')) return 'filling the volume';
  if (s.includes('layer')) return 'adding boundary layers';
  if (s.includes('check')) return 'checking the mesh';
  if (s === 'gmshtofoam' || s === 'copy_back' || s.includes('write')) return 'writing the mesh';
  return 'meshing';
}

function base(ref: JobRef, name: string): JobState {
  return { job_id: ref.job_id, kind: ref.kind, name, status: 'unknown', position: 0, progress: { fraction: null, label: '' }, result: null, error: '' };
}

/** This project's queue: its live job (or null) and its rows with their places in the whole queue. */
async function queueOf(f: FollowContext, projectId: string) {
  const q = await f.call('queue.get', { project_id: projectId }, { signal: f.signal, turn: f.turn });
  return { live: isRecord(q.live) ? q.live : null, items: rows(q.items) };
}

const started = (rec: Record<string, unknown> | null): number => {
  const t = rec ? Date.parse(String(rec.started_at ?? '')) : NaN;
  return Number.isFinite(t) ? t : NaN;
};
/** The record's result is older than this job (an earlier generate or solve of the same id). */
const olderThan = (rec: Record<string, unknown> | null, hint: StartedJob | null): boolean => {
  if (!hint) return false;
  const since = Date.parse(hint.since);
  const at = started(rec);
  // Start times are written by this server; a second of slack for the clocks of two writes.
  return Number.isFinite(since) && Number.isFinite(at) && at < since - 1_000;
};

/** The mesh record by id: in the hinted study first, then in each study of the project. */
export async function findMesh(f: FollowContext, projectId: string, meshId: string, simHint: string | null) {
  const look = async (sim: string | null) => {
    const doc = await f.call('mesh.get', { project_id: projectId, simulation_id: sim ?? '', mesh_id: meshId }, { signal: f.signal, turn: f.turn });
    const own = isRecord(doc.mesh) && String(doc.mesh.id) === meshId ? doc.mesh : rows(doc.meshes).find((m) => String(m.id) === meshId) ?? null;
    return own ? { mesh: own, simulationId: text(doc.simulation_id, 80) || text(own.simulation_id, 80) || sim || '' } : null;
  };
  const first = await look(simHint);
  if (first) return first;
  const sims = await f.call('simulation.get', { project_id: projectId }, { signal: f.signal, turn: f.turn });
  for (const s of rows(sims.simulations).slice(0, 30)) {
    const sid = text(s.id, 80);
    if (!sid || sid === simHint) continue;
    const hit = await look(sid);
    if (hit) return hit;
  }
  return null;
}

async function followMesh(f: FollowContext, projectId: string, ref: JobRef): Promise<JobState> {
  const hint = jobHint(projectId, ref.job_id);
  const found = await findMesh(f, projectId, ref.id, hint?.simulation_id || f.simulationId);
  const out = base(ref, text(found?.mesh.name) || hint?.name || ref.id);
  if (!found) {
    out.error = 'No mesh with that id in this project.';
    return out;
  }
  const { live, items } = await queueOf(f, projectId);
  const rec = isRecord(found.mesh.live_mesh_result) ? found.mesh.live_mesh_result : null;
  if (live && live.kind === 'mesh' && String(live.mesh_id) === ref.id) {
    out.status = 'running';
    out.progress = { fraction: null, label: `${out.name}: ${meshStageWords(rec?.stage)}` };
    return out;
  }
  const row = items.find((r) => r.kind === 'mesh' && String(r.mesh_id) === ref.id);
  if (row) {
    out.status = 'queued';
    out.position = num(row.position) ?? 0;
    out.progress = { fraction: null, label: `${out.name}: waiting in the queue${out.position ? ` (number ${out.position})` : ''}` };
    return out;
  }
  const st = String(rec?.status ?? '');
  if (!rec || olderThan(rec, hint)) {
    // Not running, not queued, and no result of its own: it left the queue before it started.
    out.status = hint ? 'cancelled' : found.mesh.generated ? 'done' : 'unknown';
    if (out.status === 'unknown') out.error = `${out.name} is not generating or queued.`;
    if (out.status === 'cancelled') out.error = `${out.name} left the queue before it started.`;
    return out;
  }
  if (st === 'running') {
    out.status = 'running';
    out.progress = { fraction: null, label: `${out.name}: ${meshStageWords(rec.stage)}` };
  } else if (st === 'done') {
    out.status = 'done';
    out.progress = { fraction: 1, label: `${out.name}: generated` };
    out.result = { cells: num(rec.n_cells), points: num(rec.n_points) };
  } else if (st === 'stopped') {
    out.status = 'stopped';
    out.progress = { fraction: null, label: `${out.name}: stopped` };
  } else if (st === 'failed') {
    out.status = 'failed';
    out.error = text(rec.error, 400) || 'The mesh failed.';
  }
  return out;
}

/** The run's row: in the hinted study's status, else among every run of the project. */
async function findRun(f: FollowContext, projectId: string, runId: string, simHint: string | null) {
  const st = await f.call('run.status', { project_id: projectId, simulation_id: simHint ?? '', run_id: runId }, { signal: f.signal, turn: f.turn });
  if (isRecord(st.run) && String(st.run.run_id ?? st.run.id) === runId) return st.run;
  const all = rows(st.runs_all).find((r) => String(r.id ?? r.run_id) === runId);
  if (!all) return null;
  const sim = text(all.simulation_id, 80);
  if (!sim || sim === simHint) return all;
  const again = await f.call('run.status', { project_id: projectId, simulation_id: sim, run_id: runId }, { signal: f.signal, turn: f.turn });
  return isRecord(again.run) && String(again.run.run_id ?? again.run.id) === runId ? again.run : all;
}

/** "iteration 120 of 500", or "t = 0.4 of 2 s" for a transient run. */
function solveProgress(run: Record<string, unknown>): { fraction: number | null; words: string } {
  const transient = String(run.time_dependency ?? '').toLowerCase().startsWith('transient');
  const end = num(run.endTime) ?? num((isRecord(run.transient) ? run.transient : {}).end_time);
  if (transient) {
    const t = num(run.sim_time) ?? num(run.time);
    if (t !== null && end) return { fraction: Math.min(1, t / end), words: `t = ${t} of ${end} s` };
    return { fraction: null, words: 'solving' };
  }
  const it = num(run.iteration);
  if (it !== null && end) return { fraction: Math.min(1, it / end), words: `iteration ${it} of ${end}` };
  if (it !== null) return { fraction: null, words: `iteration ${it}` };
  return { fraction: null, words: 'starting' };
}

async function followSolve(f: FollowContext, projectId: string, ref: JobRef): Promise<JobState> {
  const hint = jobHint(projectId, ref.job_id);
  const run = await findRun(f, projectId, ref.id, hint?.simulation_id || f.simulationId);
  const out = base(ref, text(run?.name) || hint?.name || ref.id);
  if (!run) {
    out.error = 'No run with that id in this project.';
    return out;
  }
  const { live, items } = await queueOf(f, projectId);
  const st = String(run.status ?? '');
  if ((live && live.kind === 'solve' && String(live.run_id) === ref.id) || st === 'running' || st === 'starting') {
    const p = solveProgress(run);
    out.status = 'running';
    out.progress = { fraction: p.fraction, label: `${out.name}: ${p.words}` };
    return out;
  }
  const row = items.find((r) => r.kind === 'solve' && String(r.run_id) === ref.id);
  if (row) {
    out.status = 'queued';
    out.position = num(row.position) ?? 0;
    out.progress = { fraction: null, label: `${out.name}: waiting in the queue${out.position ? ` (number ${out.position})` : ''}` };
    return out;
  }
  if (olderThan(run, hint) || st === 'draft' || !st) {
    out.status = hint ? 'cancelled' : 'unknown';
    out.error = hint ? `${out.name} left the queue before it started.` : `${out.name} is not running or queued.`;
    return out;
  }
  if (st === 'done') {
    out.status = 'done';
    out.progress = { fraction: 1, label: `${out.name}: done` };
    const conv = isRecord(run.converged) ? { iteration: num(run.converged.iteration), by: text(run.converged.by, 40) } : null;
    out.result = { iterations: num(run.iteration), saved_times: num(run.n_saved_times), converged: conv };
  } else if (st === 'stopped') {
    out.status = 'stopped';
    out.result = { iterations: num(run.iteration), saved_times: num(run.n_saved_times) };
  } else if (st === 'failed') {
    out.status = 'failed';
    out.error = text(run.error, 400) || text(run.note, 400) || 'The run failed.';
  }
  return out;
}

async function followExport(f: FollowContext, projectId: string, ref: JobRef): Promise<JobState> {
  const out = base(ref, 'VTK export');
  const st = await f.call('export.get', { id: ref.id, project_id: projectId }, { signal: f.signal, turn: f.turn });
  const s = String(st.status ?? '');
  const fraction = num(st.fraction);
  if (s === 'queued' || s === 'running') {
    out.status = 'running';
    out.progress = { fraction, label: `Export: ${text(st.message, 80) || 'writing'}` };
  } else if (s === 'done') {
    out.status = 'done';
    out.progress = { fraction: 1, label: 'Export: ready' };
    const name = text(st.file_name, 120) || 'results.zip';
    const bytes = num(st.bytes);
    out.result = { file_name: name, bytes, times: Array.isArray(st.times) ? st.times.length : null };
    out.download = { name, bytes, href: `/api/results/export-vtk/${encodeURIComponent(ref.id)}/file?project_id=${encodeURIComponent(projectId)}` };
  } else if (s === 'stopped') {
    out.status = 'cancelled';
  } else if (s === 'failed') {
    out.status = 'failed';
    out.error = text(st.error, 400) || 'The export failed.';
  }
  return out;
}

const LINK_LIVE = new Set(['queued', 'running', 'choosing', 'waiting', 'starting']);

async function followLink(f: FollowContext, projectId: string, ref: JobRef): Promise<JobState> {
  const hint = jobHint(projectId, ref.job_id);
  const out = base(ref, hint?.name || 'Geometry update');
  if (!hint?.plugin || !hint.study_id) {
    out.error = "This link job's workspace is not known here; follow it in the window that sent the design.";
    return out;
  }
  const st = await f.call('link.status', { project_id: projectId, plugin: hint.plugin, study_id: hint.study_id, job_id: ref.id }, { signal: f.signal, turn: f.turn });
  const job = isRecord(st.job) ? st.job : {};
  const s = String(job.status ?? '');
  if (s === 'choosing') {
    out.status = 'running';
    out.waiting = true;
    out.progress = { fraction: null, label: `${out.name}: waiting for your answer` };
  } else if (LINK_LIVE.has(s)) {
    out.status = s === 'queued' ? 'queued' : 'running';
    out.position = num(job.ahead) ?? 0;
    out.progress = { fraction: null, label: `${out.name}: ${text(job.stage, 60) || s}` };
  } else if (s === 'done') {
    out.status = 'done';
    out.result = { geometry: text(job.geometryName) };
  } else if (s === 'cancelled') {
    out.status = 'cancelled';
  } else if (s) {
    out.status = 'failed';
    out.error = text(job.error, 400) || `The geometry update ended: ${s}.`;
  }
  return out;
}

async function followEnv(f: FollowContext, ref: JobRef): Promise<JobState> {
  const st = await f.call('plugins.env.get', { key: ref.id }, { signal: f.signal, turn: f.turn });
  const out = base(ref, `${text(st.name) || ref.id} tools`);
  const install = isRecord(st.install) ? st.install : null;
  const env = isRecord(st.env) ? st.env : null;
  const s = String(install?.state ?? env?.state ?? '');
  if (s === 'installing' || s === 'running' || s === 'queued') {
    out.status = 'running';
    out.progress = { fraction: null, label: `${out.name}: ${text(install?.label, 80) || text(install?.stage, 60) || 'installing'}` };
  } else if (s === 'ready' || s === 'done') {
    out.status = 'done';
  } else if (s === 'failed' || s === 'error') {
    out.status = 'failed';
    out.error = text(install?.error ?? env?.error, 400) || 'The install failed.';
  } else if (s === 'cancelled' || s === 'stopped') {
    out.status = 'cancelled';
  }
  return out;
}

/**
 * One job's state now. A job it can't read (gone, another project's, a refused read)
 * is `unknown` with why; a transport failure (timeout, rate) rejects, for the caller.
 */
export async function followJob(f: FollowContext, projectId: string | null, ref: JobRef): Promise<JobState> {
  try {
    if (ref.kind === 'hw') return { ...base(ref, 'This PC check'), status: 'done', progress: { fraction: 1, label: 'This PC: checked' } };
    if (ref.kind === 'env') return await followEnv(f, ref);
    if (!projectId) return { ...base(ref, ref.id), error: 'Pass project_id: this job belongs to a project.' };
    if (ref.kind === 'mesh') return await followMesh(f, projectId, ref);
    if (ref.kind === 'solve') return await followSolve(f, projectId, ref);
    if (ref.kind === 'export') return await followExport(f, projectId, ref);
    return await followLink(f, projectId, ref);
  } catch (err) {
    if (err instanceof HostCallError && err.code === 'http' && err.status !== null && err.status < 500) {
      return { ...base(ref, ref.id), error: err.message };
    }
    throw err;
  }
}
