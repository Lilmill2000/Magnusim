/**
 * What the Assistant started (spec 06 §8.3): each job a compute call started or queued goes
 * on its owner's list in the chain-grant store (grants().started: the turn, or `mcp:<id>`),
 * so the turn's end can name what still runs; and here, the hints a later wait needs to
 * follow a job by its id alone (the study of a mesh or run, the plugin and study of a link
 * job, the job's name, when it started).
 *
 * Stop on a turn leaves approved meshes and runs running (Daniel, Q2): the turn's end
 * line names them and how to stop them. "Still running" is read from this server's own
 * compute slot and queue at that moment (in-process, synchronous: the end can't wait), not
 * from what the turn last saw.
 */
import { computeSlotHolder, sameProjectFolder } from '../../../compute-slot.js';
import { snapshotComputeQueue } from '../../compute-queue.ts';
import { grants } from '../grants.ts';
import { cleanText, TEXT_CAPS } from '../sanitize.ts';
import type { JobKind, JobStatus } from './job-state.ts';

export interface StartedJob {
  job_id: string;
  kind: JobKind;
  id: string;
  name: string;
  project_id: string;
  simulation_id: string;
  /** A link job's plugin and study (its status route is scoped to them). */
  plugin?: string;
  study_id?: string;
  /** When the call started it: an older result of the same mesh or run is not this job's. */
  since: string;
  /** What the turn last read of it. */
  last: JobStatus;
}

const TURNS_KEPT = 200;
const HINTS_KEPT = 500;
const byTurn = new Map<string, Map<string, StartedJob>>();
const hints = new Map<string, StartedJob>();
const hintKey = (projectId: string, jobId: string) => `${projectId}|${jobId}`;

/** A job a turn (or an MCP session, `mcp:<id>`) started. */
export function rememberJob(turn: string | null, job: StartedJob): void {
  const h = { ...job, name: cleanText(job.name, TEXT_CAPS.name) };
  hints.delete(hintKey(job.project_id, job.job_id));
  hints.set(hintKey(job.project_id, job.job_id), h);
  while (hints.size > HINTS_KEPT) hints.delete(hints.keys().next().value as string);
  if (!turn) return;
  grants().started(turn, { job: job.job_id, label: h.name || job.job_id });
  let jobs = byTurn.get(turn);
  if (!jobs) {
    jobs = new Map();
    byTurn.set(turn, jobs);
    while (byTurn.size > TURNS_KEPT) byTurn.delete(byTurn.keys().next().value as string);
  }
  jobs.set(job.job_id, h);
}

/** What is known of a job of this project (any turn's), or null. */
export function jobHint(projectId: string, jobId: string): StartedJob | null {
  return hints.get(hintKey(projectId, jobId)) ?? null;
}

/** The turn read a job's state. */
export function noteJobState(turn: string | null, jobId: string, status: JobStatus, name?: string): void {
  const rec = turn ? byTurn.get(turn)?.get(jobId) : null;
  if (!rec) return;
  rec.last = status;
  if (name) rec.name = cleanText(name, TEXT_CAPS.name);
}

/** The jobs the turn started, oldest first (the grant store's list, with what is known of each). */
export function startedJobs(turn: string): StartedJob[] {
  const own = byTurn.get(turn);
  return grants()
    .startedBy(turn)
    .map((g) => own?.get(g.job))
    .filter((j): j is StartedJob => !!j);
}

export function forgetTurnJobs(turn: string): void {
  byTurn.delete(turn);
}

/** Running or queued now, by this server's own slot and queue; others by what was last read. */
export type LiveCheck = (job: StartedJob) => 'running' | 'queued' | 'ended';

export const liveInProcess: LiveCheck = (job) => {
  if (job.kind !== 'mesh' && job.kind !== 'solve') {
    return job.last === 'running' || job.last === 'queued' ? job.last : 'ended';
  }
  const h = computeSlotHolder();
  const field = job.kind === 'mesh' ? 'mesh_id' : 'run_id';
  if (h && h.kind === job.kind && String(h[field] ?? '') === job.id && sameProjectFolder(h.project_id, job.project_id)) return 'running';
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = (snapshotComputeQueue(job.project_id).items ?? []) as unknown as Array<Record<string, unknown>>;
  } catch {
    rows = [];
  }
  return rows.some((r) => r.kind === job.kind && String(r[field] ?? '') === job.id) ? 'queued' : 'ended';
};

let check: LiveCheck = liveInProcess;

/** Tests: how "still running" is read (null: the server's own slot and queue). */
export function setLiveCheckForTests(fn: LiveCheck | null): void {
  check = fn ?? liveInProcess;
}

/**
 * The turn's end line when something it started still runs or waits:
 * "Still running: Mesh 1, Run 1. Stop them from the tree, the Queue, or ask the Assistant."
 * null when nothing does. Read in Turn.end, before the turn's grants end (turns.ts launch's
 * finally); the turn's own record of its jobs goes with it.
 */
export function stillRunningNote(turn: string): string | null {
  const jobs = startedJobs(turn);
  forgetTurnJobs(turn);
  const names: string[] = [];
  for (const job of jobs) {
    let state: ReturnType<LiveCheck>;
    try {
      state = check(job);
    } catch {
      state = 'ended';
    }
    if (state === 'ended') continue;
    const name = job.name || job.job_id;
    names.push(state === 'queued' ? `${name} (queued)` : name);
  }
  if (!names.length) return null;
  const them = names.length === 1 ? 'it' : 'them';
  return `Still running: ${names.join(', ')}. Stop ${them} from the tree, the Queue, or ask the Assistant.`;
}
