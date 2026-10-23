/**
 * `jobs` (spec 06 §4.14): stops and orders the work running and waiting on this PC, for
 * the project open in the turn's window, through the routes the person's buttons use.
 *
 *   stop · mesh.<id>       POST /api/mesh/stop (deletes nothing; a queued mesh leaves the queue)
 *   stop · solve.<id>      POST /api/run/stop (graceful: the current step is written)
 *   force_stop · solve     POST /api/run/stop {force} (destructive: ends it at once)
 *   stop · export          as cancel_export
 *   unqueue                POST /api/compute-queue {action:'remove'} of this project's row
 *   reorder                PATCH /api/compute-queue {ids}: only this project's rows
 *   cancel_export          POST /api/jobs/:id/stop
 *
 * The queue's routes take a row of any project (finding 8), so the project check is here:
 * a row id that is not this project's is not found.
 */
import { HostCallError } from '../host-call.ts';
import { HOST_STALL_MS, type AssessContext, type Assessed, type Place, type ToolCtx, type ToolDef, type ToolOutcome, type ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import type { JsonSchemaObject } from '../types.ts';
import { emitSync, fail, failedCall, isRecord, quoted, rows, str, text, writeProject, type JobToolDeps } from './job-common.ts';
import { findMesh, parseJobId, type JobRef } from './job-state.ts';
import { jobHint, noteJobState } from './turn-jobs.ts';

export const JOBS_ACTIONS = ['stop', 'force_stop', 'unqueue', 'reorder', 'cancel_export'] as const;
type Action = (typeof JOBS_ACTIONS)[number];
export const JOBS_CONTEXTS: readonly Place[] = Object.freeze(['home', 'workbench']);
const ROW_ID = /^q-[A-Za-z0-9._-]{1,60}$/;

export const JOBS_SCHEMA: JsonSchemaObject = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'action', 'job_id', 'ids'],
  properties: {
    project_id: { type: 'string', maxLength: 80, description: '"" = this window\'s project' },
    action: { type: 'string', enum: [...JOBS_ACTIONS] },
    job_id: { type: 'string', maxLength: 100, description: 'mesh.<id>, solve.<id>, export.<id>, or a queue row q-…; "" for reorder' },
    ids: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 40 }, description: "reorder: this project's queue rows, in the order wanted; [] otherwise" },
  },
}) as JsonSchemaObject;

const DESCRIPTION =
  'Stop or order work on this PC for this project: stop (a mesh, a run gracefully, an export), force_stop (a run at once), unqueue (a waiting job), reorder (ids: this project\'s queue rows in order), cancel_export. job_id from compute or a queue row q-…; "" and [] when unused.';

export function createJobsTool(deps: JobToolDeps): ToolDef {
  const call = deps.call;
  const o = (rt: { signal: AbortSignal; turn: string | null }) => ({ signal: rt.signal, turn: rt.turn, tool: 'jobs' });
  const ok = (done: string, data: Record<string, unknown> = {}): ToolOutcome => ({ ok: true, data: { done, ...data }, summary: done });

  /** The run's name for a card or an answer ("Run 1"), or its id. */
  async function runName(projectId: string, runId: string, simHint: string | null, rt: { signal: AbortSignal; turn: string | null }): Promise<string> {
    const hint = jobHint(projectId, `solve.${runId}`);
    if (hint?.name) return hint.name;
    try {
      const st = await call('run.status', { project_id: projectId, simulation_id: simHint ?? '', run_id: runId }, o(rt));
      const row = (isRecord(st.run) && String(st.run.run_id ?? st.run.id) === runId ? st.run : null) ?? rows(st.runs_all).find((r) => String(r.id ?? r.run_id) === runId);
      return text(row?.name) || runId;
    } catch {
      return runId;
    }
  }

  async function escalate(input: Record<string, unknown>, rt: AssessContext): Promise<Assessed | null> {
    if (str(input.action) !== 'force_stop') return null;
    const ref = parseJobId(input.job_id);
    const projectId = str(input.project_id) || rt.ctx.projectId || '';
    const name = ref && ref.kind === 'solve' && projectId ? await runName(projectId, ref.id, rt.ctx.simulationId, rt) : 'the run';
    return { risk: 'destructive', note: `Ends ${name} at once; its last time step may be incomplete.`, detail: [{ label: 'Run', value: name }] };
  }

  function gateText(_input: Record<string, unknown>, a: Assessed | null) {
    const name = a?.detail.find((d) => d.label === 'Run')?.value ?? 'the run';
    return { title: `Allow the Assistant to force-stop ${quoted(name)}?`, copy: 'Ends it at once; its last time step may be incomplete.', ...(a?.detail.length ? { detail: a.detail } : {}) };
  }

  async function stopMesh(projectId: string, ref: JobRef, rt: ToolRunContext): Promise<ToolOutcome> {
    const found = await findMesh({ call, signal: rt.signal, turn: rt.turn, simulationId: rt.ctx.simulationId }, projectId, ref.id, jobHint(projectId, ref.job_id)?.simulation_id || rt.ctx.simulationId);
    if (!found) return fail('not_found', 'That mesh is not in this project.', "read_setup {what:'meshes'} lists them.");
    const name = text(found.mesh.name) || ref.id;
    try {
      const r = await call('mesh.stop', { project_id: projectId, simulation_id: found.simulationId, mesh_id: ref.id }, o(rt));
      noteJobState(rt.turn, ref.job_id, r.unqueued === true ? 'cancelled' : 'stopped');
      emitSync(deps, rt, { project_id: projectId, simulation_id: found.simulationId, kinds: ['mesh'], ids: { mesh: [ref.id] }, revs: {}, tool: 'jobs.stop' });
      return ok(r.unqueued === true ? `${name} left the queue` : `Stopped ${name}; it is not generated, and its settings are kept`, { job_id: ref.job_id, status: r.unqueued === true ? 'cancelled' : 'stopped' });
    } catch (err) {
      if (err instanceof HostCallError && err.status === 409 && err.appCode === 'not_running') {
        return fail('not_running', `${name} is not generating or queued.`, `wait {job_ids:["${ref.job_id}"]} says how it ended.`);
      }
      return failedCall(err);
    }
  }

  async function stopSolve(projectId: string, ref: JobRef, force: boolean, rt: ToolRunContext): Promise<ToolOutcome> {
    const name = await runName(projectId, ref.id, jobHint(projectId, ref.job_id)?.simulation_id || rt.ctx.simulationId, rt);
    // A queued run leaves the queue (the route stops only one that runs).
    const q = await call('queue.get', { project_id: projectId }, o(rt));
    const row = rows(q.items).find((r) => r.kind === 'solve' && String(r.run_id) === ref.id);
    const live = isRecord(q.live) && q.live.kind === 'solve' && String(q.live.run_id) === ref.id;
    if (row && !live) return unqueueRow(projectId, row, rt, `${name} left the queue`);
    try {
      const r = await call('run.stop', { project_id: projectId, run_id: ref.id, force }, o(rt));
      const forced = r.forced === true || force;
      noteJobState(rt.turn, ref.job_id, r.stopped === true ? 'stopped' : 'running');
      emitSync(deps, rt, { project_id: projectId, simulation_id: jobHint(projectId, ref.job_id)?.simulation_id || null, kinds: ['runs'], ids: { run: [ref.id] }, revs: {}, tool: `jobs.${force ? 'force_stop' : 'stop'}` });
      const done = r.stopped === true ? `Stopped ${name}${forced ? ' at once' : ''}` : `Stopping ${name}: it writes its current step first`;
      return ok(done, { job_id: ref.job_id, status: r.stopped === true ? 'stopped' : 'stopping', hint: r.stopped === true ? '' : `wait {job_ids:["${ref.job_id}"]} until it says stopped; force_stop ends it at once.` });
    } catch (err) {
      if (err instanceof HostCallError && err.status === 409) return fail('not_running', `${name} is not running.`);
      return failedCall(err);
    }
  }

  async function unqueueRow(projectId: string, row: Record<string, unknown>, rt: ToolRunContext, done?: string): Promise<ToolOutcome> {
    const kind = String(row.kind ?? '');
    const id = String(row.id ?? '');
    try {
      await call('queue.remove', { kind, id, project_id: projectId }, o(rt));
    } catch (err) {
      return failedCall(err);
    }
    const jobId = kind === 'mesh' && row.mesh_id ? `mesh.${row.mesh_id}` : kind === 'solve' && row.run_id ? `solve.${row.run_id}` : '';
    if (jobId) noteJobState(rt.turn, jobId, 'cancelled');
    emitSync(deps, rt, { project_id: projectId, simulation_id: text(row.simulation_id, 80) || null, kinds: ['tree'], ids: {}, revs: {}, tool: 'jobs.unqueue' });
    return ok(done ?? `${text(row.name) || 'The job'} left the queue`, { job_id: jobId, row: cleanText(id, 60), status: 'cancelled' });
  }

  async function unqueue(projectId: string, jobId: string, rt: ToolRunContext): Promise<ToolOutcome> {
    // The queue lists only this project's rows for it: another project's row id is not found here.
    const q = await call('queue.get', { project_id: projectId }, o(rt));
    const items = rows(q.items);
    const ref = parseJobId(jobId);
    const row = ROW_ID.test(jobId)
      ? items.find((r) => String(r.id) === jobId)
      : ref && (ref.kind === 'mesh' || ref.kind === 'solve')
        ? items.find((r) => r.kind === ref.kind && String(ref.kind === 'mesh' ? r.mesh_id : r.run_id) === ref.id)
        : undefined;
    if (!row) return fail('not_found', "No such job waits in this project's queue.", "app_status lists the queue.");
    return unqueueRow(projectId, row, rt);
  }

  async function reorder(projectId: string, ids: string[], rt: ToolRunContext): Promise<ToolOutcome> {
    if (!ids.length) return fail('bad_values', 'reorder needs ids: this project\'s queue rows, in the order wanted.', '', [{ key: 'ids', problem: 'empty' }]);
    const q = await call('queue.get', { project_id: projectId }, o(rt));
    const mine = new Set(rows(q.items).map((r) => String(r.id)));
    const foreign = ids.filter((id) => !mine.has(id));
    if (foreign.length) {
      return fail('not_found', "Some ids are not this project's queue rows.", 'app_status lists the queue.', foreign.slice(0, 12).map((id) => ({ key: 'ids', problem: `${cleanText(id, 40)} is not one of this project's rows` })));
    }
    try {
      await call('queue.reorder', { ids }, o(rt));
    } catch (err) {
      if (err instanceof HostCallError && err.status === 400) return fail('bad_order', err.message, 'A run waits after the mesh it uses.');
      return failedCall(err);
    }
    emitSync(deps, rt, { project_id: projectId, simulation_id: null, kinds: ['tree'], ids: {}, revs: {}, tool: 'jobs.reorder' });
    return ok(`Reordered ${ids.length} queued job${ids.length === 1 ? '' : 's'}`, { ids });
  }

  async function cancelExport(projectId: string, ref: JobRef, rt: ToolRunContext): Promise<ToolOutcome> {
    try {
      await call('jobs.stop', { id: ref.id, project_id: projectId }, o(rt));
    } catch (err) {
      return failedCall(err, 'That export is not in this project.');
    }
    noteJobState(rt.turn, ref.job_id, 'cancelled');
    return ok('Cancelled the export', { job_id: ref.job_id, status: 'cancelled' });
  }

  return {
    name: 'jobs',
    localName: 'jobs',
    title: 'Stop or order jobs',
    description: DESCRIPTION,
    schema: JOBS_SCHEMA,
    risk: 'edit',
    source: { kind: 'host' },
    projectData: true,
    stallMs: HOST_STALL_MS,
    workerBacked: false,
    priority: 58,
    contexts: JOBS_CONTEXTS,
    available: () => true,
    escalate,
    gateText,
    projectOf: (input: Record<string, unknown>, ctx: ToolCtx) => str(input.project_id) || ctx.projectId,
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const action = str(input.action) as Action;
      const project = writeProject(input, rt.ctx);
      if (!project.ok) return project.out;
      const projectId = project.id;
      const jobId = str(input.job_id);
      try {
        if (action === 'reorder') return await reorder(projectId, (Array.isArray(input.ids) ? input.ids : []).map((x) => String(x)), rt);
        if (action === 'unqueue') return await unqueue(projectId, jobId, rt);
        const ref = parseJobId(jobId);
        if (!ref) return fail('bad_values', 'job_id takes an id compute returned (mesh.<id>, solve.<id>, export.<job-…>).', '', [{ key: 'job_id', problem: 'not a job id' }]);
        if (action === 'cancel_export') {
          if (ref.kind !== 'export') return fail('invalid_input', 'cancel_export takes an export.<job-…> id.');
          return await cancelExport(projectId, ref, rt);
        }
        if (action === 'force_stop') {
          if (ref.kind !== 'solve') return fail('invalid_input', 'force_stop takes a run (solve.<id>); stop ends a mesh or an export.');
          return await stopSolve(projectId, ref, true, rt);
        }
        if (action !== 'stop') return fail('invalid_input', `Unknown action ${cleanText(String(action), 40)}.`);
        if (ref.kind === 'mesh') return await stopMesh(projectId, ref, rt);
        if (ref.kind === 'solve') return await stopSolve(projectId, ref, false, rt);
        if (ref.kind === 'export') return await cancelExport(projectId, ref, rt);
        if (ref.kind === 'link') return fail('cannot_stop', 'A geometry update has no stop.', 'A queued update can be unqueued.');
        return fail('cannot_stop', 'This job has no stop.', ref.kind === 'env' ? "An install runs to its end; the plugin's page shows it." : '');
      } catch (err) {
        return failedCall(err);
      }
    },
  };
}
