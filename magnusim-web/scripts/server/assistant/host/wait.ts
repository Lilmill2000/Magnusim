/**
 * `wait` (spec 06 §4.13, §8.2-8.3): follows up to four jobs by their ids until they end
 * (all, or any) or `timeout_s` runs out, polling each every 2 s through the app's routes.
 *
 * - Each poll reports progress ("Mesh 1: meshing the surface", "Run 1: iteration 120 of
 *   500"), so the stall window never trips while a job lives; a link job waiting for the
 *   person's answer says so (`waiting`: the turn's minutes stop).
 * - Stop aborts the wait at once; the jobs keep running (Daniel, Q2), and the next turn
 *   may wait on the same ids. The turn's minutes cap bounds it like any call.
 * - A finished export gives the person a Download link in the dock (`links`, §8.6); the
 *   model gets the file's name and size, never the address.
 */
import { HostCallError } from '../host-call.ts';
import { HOST_STALL_MS, type Place, type ToolCtx, type ToolDef, type ToolOutcome, type ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import type { JsonSchemaObject } from '../types.ts';
import { fail, failedCall, num, readProject, str, type JobToolDeps, type JsonCall } from './job-common.ts';
import { ENDED, followJob, parseJobId, type JobRef, type JobState } from './job-state.ts';
import { noteJobState } from './turn-jobs.ts';

/**
 * Where wait is offered (spec §15): in a workspace too, so a CAD turn can wait on a mesh or a
 * geometry update it started (the CAD Part's request: its 22 tools, then the app's 9).
 */
export const WAIT_CONTEXTS: readonly Place[] = Object.freeze(['home', 'workbench', 'workspace']);
export const WAIT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 600;

export const WAIT_SCHEMA: JsonSchemaObject = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'job_ids', 'until', 'timeout_s'],
  properties: {
    project_id: { type: 'string', maxLength: 80, description: '"" = this window\'s project' },
    job_ids: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 100 }, description: 'from compute, e.g. "mesh.m-1", "solve.r-2", "export.job-…"' },
    until: { type: 'string', enum: ['all', 'any'] },
    timeout_s: { type: 'integer', minimum: 0, maximum: MAX_TIMEOUT_S, description: '0 = 300' },
  },
}) as JsonSchemaObject;

const DESCRIPTION =
  'Follow jobs that compute started (mesh.<id>, solve.<id>, export.<job-…>, link.<gl-…>, env.<key>, hw.check) until all or any end, or timeout_s passes (0 = 300). Returns each job\'s status, progress and result. A job keeps running when the wait ends or is stopped: call wait again with the same ids.';

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** One poll's reads of the queue and the study list, shared by every job it follows (the 5/s rate). */
function pollCall(call: JsonCall): JsonCall {
  const memo = new Map<string, Promise<Record<string, unknown>>>();
  return (id, args, o) => {
    if (id !== 'queue.get' && id !== 'simulation.get') return call(id, args, o);
    const key = `${id}|${JSON.stringify(args)}`;
    let hit = memo.get(key);
    if (!hit) {
      hit = call(id, args, o);
      memo.set(key, hit);
      hit.catch(() => memo.delete(key));
    }
    return hit;
  };
}

/** "Mesh 1 done; Run 1 running (iteration 120 of 500)". */
function summaryOf(jobs: JobState[], timedOut: boolean): string {
  const parts = jobs.map((j) => `${j.name || j.job_id} ${j.status}`);
  return cleanText(`${timedOut ? 'Still waiting: ' : ''}${parts.join('; ')}`, 160);
}

export function createWaitTool(deps: JobToolDeps): ToolDef {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? WAIT_POLL_MS;
  return {
    name: 'wait',
    localName: 'wait',
    title: 'Wait for jobs',
    description: DESCRIPTION,
    schema: WAIT_SCHEMA,
    risk: 'read',
    source: { kind: 'host' },
    projectData: true,
    stallMs: HOST_STALL_MS,
    workerBacked: false,
    priority: 82,
    contexts: WAIT_CONTEXTS,
    available: () => true,
    projectOf: (input: Record<string, unknown>, ctx: ToolCtx) => readProject(input, ctx),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const raw = Array.isArray(input.job_ids) ? input.job_ids : [];
      const refs: JobRef[] = [];
      const bad: Array<{ key: string; problem: string }> = [];
      for (const id of raw) {
        const ref = parseJobId(id);
        if (ref) {
          if (!refs.some((r) => r.job_id === ref.job_id)) refs.push(ref);
        } else bad.push({ key: 'job_ids', problem: `${cleanText(String(id), 100)} is not a job id` });
      }
      if (bad.length || !refs.length) {
        return fail('bad_values', 'job_ids takes the ids compute returned: mesh.<id>, solve.<id>, export.<job-…>, link.<gl-…>, env.<key> or hw.check.', '', bad.slice(0, 12));
      }
      const projectId = readProject(input, rt.ctx);
      const any = str(input.until) === 'any';
      const asked = num(input.timeout_s) ?? 0;
      const timeoutMs = Math.min(MAX_TIMEOUT_S, asked > 0 ? asked : DEFAULT_TIMEOUT_S) * 1000;
      const deadline = now() + timeoutMs;
      const states = new Map<string, JobState>();
      const done = () => {
        const ended = refs.filter((r) => {
          const s = states.get(r.job_id);
          return !!s && ENDED.has(s.status);
        }).length;
        return any ? ended > 0 : ended === refs.length;
      };

      for (;;) {
        const call = pollCall(deps.call);
        for (const ref of refs) {
          const was = states.get(ref.job_id);
          if (was && ENDED.has(was.status)) continue;
          if (rt.signal.aborted) break;
          let state: JobState;
          try {
            state = await followJob({ call, signal: rt.signal, turn: rt.turn, simulationId: rt.ctx.simulationId }, projectId, ref);
          } catch (err) {
            if (err instanceof HostCallError && (err.code === 'rate_limited' || err.code === 'timeout' || err.code === 'unreachable')) {
              // A busy moment: the next poll reads it again.
              continue;
            }
            if (err instanceof HostCallError && err.code === 'aborted') break;
            return failedCall(err);
          }
          states.set(ref.job_id, state);
          noteJobState(rt.turn, ref.job_id, state.status, state.name);
        }
        if (rt.signal.aborted) return fail('stopped', 'Stopped while waiting; the jobs keep running.', 'Call wait again with the same job ids.');
        const list = refs.map((r) => states.get(r.job_id)).filter((s): s is JobState => !!s);
        const live = list.find((s) => !ENDED.has(s.status));
        if (live) rt.progress(live.progress.fraction, live.progress.label || `${live.name}: ${live.status}`, live.waiting ? { waiting: true } : undefined);
        const timedOut = !done() && now() + Math.min(pollMs, 250) >= deadline;
        if (done() || timedOut) {
          const jobs = list.map((s) => {
            const { download: _dl, ...rest } = s;
            return rest;
          });
          const links = list
            .filter((s) => s.download)
            .map((s) => ({ label: `Download ${s.download!.name}`, href: s.download!.href }));
          return {
            ok: true,
            data: { ended: done(), timed_out: timedOut, jobs, ...(timedOut ? { hint: 'Call wait again with the same job ids.' } : {}) },
            ...(links.length ? { links } : {}),
            summary: summaryOf(list, timedOut),
          };
        }
        await sleep(Math.max(0, Math.min(pollMs, deadline - now())), rt.signal);
      }
    },
  };
}
