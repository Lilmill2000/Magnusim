/**
 * `compute` (spec 06 §4.12): starts work on this PC through the app's own routes, as the
 * person's buttons do, and returns as soon as the job runs or waits in the queue, with a
 * job id to follow with `wait`.
 *
 *   mesh_generate       POST /api/mesh/generate (queued when busy); the stored settings
 *   run_start           POST /api/run/start; busy: queued as the page queues it
 *   run_continue        POST /api/run/continue (extra_iterations or end_time); busy: queued
 *   vtk_export          POST /api/results/export-vtk of the run's case (never its path to the model)
 *   hardware_check      POST /api/prefs/hardware-check (about a minute; no project)
 *   plugin_env_install  POST /api/plugins/:key/env/install (no project)
 *   queue_kick          POST /api/compute-queue/kick (starts only what is already queued)
 *
 * Every call but queue_kick asks first (a compute card); a declared `chain` lets one card
 * cover the later steps (C3, §7.2). Continuing a converged run and generating a generated
 * mesh again ask as destructive. Writes go only to the project open in the turn's window.
 */
import type { GateDetail } from '../gates.ts';
import { HostCallError } from '../host-call.ts';
import { HOST_STALL_MS, type AssessContext, type Assessed, type Place, type ToolCtx, type ToolDef, type ToolOutcome, type ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import type { JsonSchemaObject } from '../types.ts';
import {
  emitSync,
  fail,
  failedCall,
  freshId,
  isRecord,
  num,
  projectTitle,
  quoted,
  rows,
  str,
  studyFor,
  text,
  withHeartbeat,
  writeProject,
  type JobToolDeps,
} from './job-common.ts';
import { jobIdOf, parseJobId, type JobKind } from './job-state.ts';
import { rememberJob } from './turn-jobs.ts';

export const COMPUTE_ACTIONS = ['mesh_generate', 'run_start', 'run_continue', 'vtk_export', 'hardware_check', 'plugin_env_install', 'queue_kick'] as const;
type Action = (typeof COMPUTE_ACTIONS)[number];
export const COMPUTE_CONTEXTS: readonly Place[] = Object.freeze(['home', 'workbench']);
/** The actions that need no project (offered from Home too). */
const NO_PROJECT: ReadonlySet<string> = new Set(['hardware_check', 'plugin_env_install']);
const PLUGIN_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const COMPUTE_SCHEMA: JsonSchemaObject = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['project_id', 'simulation_id', 'action', 'mesh_id', 'run_id', 'extra_iterations', 'end_time', 'frames', 'time', 'plugin', 'chain', 'estimate_minutes'],
  properties: {
    project_id: { type: 'string', maxLength: 80, description: '"" = this window\'s project' },
    simulation_id: { type: 'string', maxLength: 80, description: '"" = the study shown' },
    action: { type: 'string', enum: [...COMPUTE_ACTIONS] },
    mesh_id: { type: 'string', maxLength: 80, description: '"" = the active mesh' },
    run_id: { type: 'string', maxLength: 80, description: '"" = the active run' },
    extra_iterations: { type: 'integer', minimum: 0, maximum: 1000000, description: 'run_continue steady: iterations to add' },
    end_time: { type: 'number', minimum: 0, description: 'run_continue transient: run on to this time' },
    frames: { type: 'string', enum: ['', 'current', 'all'], description: 'vtk_export; "" = current' },
    time: { type: 'number', description: 'vtk_export current frame; -1 = latest' },
    plugin: { type: 'string', maxLength: 64, description: 'plugin_env_install: its key' },
    chain: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', maxLength: 100 },
      description: 'job ids this card should also cover, in order, e.g. ["mesh.m-1","solve.r-2"]; [] = this call only',
    },
    estimate_minutes: { type: 'number', minimum: 0, maximum: 100000, description: 'your estimate for the card; 0 = none' },
  },
}) as JsonSchemaObject;

const DESCRIPTION =
  'Start work on this PC: mesh_generate, run_start, run_continue (extra_iterations or end_time), vtk_export (frames, time -1 = latest), hardware_check, plugin_env_install (plugin), queue_kick. Returns at once with a job_id; follow it with wait. Unused fields: "", 0, [] (chain). chain: later job ids one approval also covers.';

const ENGINES: Record<string, string> = { standard: 'Standard', snappy_hexdominant: 'Hex-dominant', cfmesh: 'cfMesh' };
const engineOf = (mesh: Record<string, unknown>): string => {
  const settings = isRecord(mesh.settings) ? mesh.settings : {};
  const adv = isRecord(settings.advanced) ? settings.advanced : {};
  const key = str(mesh.ui_mesh_engine) || str(adv.mesh_engine) || str(settings.algorithm).toLowerCase() || 'standard';
  return ENGINES[key] ?? cleanText(key, 40);
};
const cellsWords = (n: number | null): string => (n === null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M cells` : n >= 1e3 ? `${Math.round(n / 1e3)} k cells` : `${n} cells`);
const ordinal = (n: number): string => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

/** The job id this call would start (chain grants, C3); null when it can't be known from the input alone. */
export function computeChainKey(input: Record<string, unknown>): string | null {
  const action = str(input.action);
  if (action === 'mesh_generate') return str(input.mesh_id) ? jobIdOf('mesh', str(input.mesh_id)) : null;
  if (action === 'run_start' || action === 'run_continue') return str(input.run_id) ? jobIdOf('solve', str(input.run_id)) : null;
  return null;
}

interface RunFound {
  run: Record<string, unknown>;
  id: string;
  name: string;
  all: Record<string, unknown>[];
}

export function createComputeTool(deps: JobToolDeps): ToolDef {
  const call = deps.call;
  const newId = deps.newId ?? freshId;
  const o = (rt: { signal: AbortSignal; turn: string | null }) => ({ signal: rt.signal, turn: rt.turn, tool: 'compute' });

  /** The study's mesh: the given id, else its active one. */
  async function meshOf(projectId: string, simId: string, meshId: string, rt: { signal: AbortSignal; turn: string | null }) {
    const doc = await call('mesh.get', { project_id: projectId, simulation_id: simId, mesh_id: meshId }, o(rt));
    const all = rows(doc.meshes);
    const mesh = meshId
      ? (isRecord(doc.mesh) && String(doc.mesh.id) === meshId ? doc.mesh : all.find((m) => String(m.id) === meshId) ?? null)
      : isRecord(doc.mesh) && doc.mesh.id
        ? doc.mesh
        : null;
    return mesh;
  }

  /** The study's run: the given id, else its active one, with every run of the study. */
  async function runOf(projectId: string, simId: string, runId: string, rt: { signal: AbortSignal; turn: string | null }): Promise<RunFound | null> {
    const st = await call('run.status', { project_id: projectId, simulation_id: simId, run_id: runId }, o(rt));
    const all = rows(st.runs);
    const want = runId || text(st.active_run_id, 80);
    if (!want) return null;
    const run = isRecord(st.run) && String(st.run.run_id ?? st.run.id) === want ? st.run : all.find((r) => String(r.id ?? r.run_id) === want) ?? null;
    if (!run) return null;
    return { run, id: want, name: text(run.name) || want, all };
  }

  const meshGenerated = (mesh: Record<string, unknown> | null): boolean => {
    const live = mesh && isRecord(mesh.live_mesh_result) ? mesh.live_mesh_result : null;
    return !!mesh && (mesh.generated === true || String(live?.status ?? '') === 'done');
  };
  const runConverged = (run: Record<string, unknown>): boolean => !!run.converged && String(run.status ?? '') !== 'running';

  async function queueNow(rt: { signal: AbortSignal; turn: string | null }) {
    try {
      const q = await call('queue.get', { project_id: '' }, o(rt));
      return { busy: isRecord(q.live) || isRecord(q.busy), waiting: rows(q.items).length };
    } catch {
      return null;
    }
  }
  const queueWords = (q: { busy: boolean; waiting: number } | null): string =>
    !q ? 'unknown' : !q.busy && !q.waiting ? 'starts now' : `${ordinal(q.waiting + 1)} in line`;

  /** Names of the chained jobs, for the card ("Generate "Mesh 1"", "Start "Run 1""), and each by its job id (the covered call's transcript line). */
  async function chainSteps(projectId: string, simId: string, chain: string[], rt: AssessContext): Promise<{ steps: string[]; labels: Record<string, string> }> {
    const steps: string[] = [];
    const labels: Record<string, string> = {};
    for (const raw of chain) {
      const ref = parseJobId(raw);
      if (!ref) continue;
      let step = ref.job_id;
      try {
        if (ref.kind === 'mesh') step = `Generate ${quoted(text((await meshOf(projectId, simId, ref.id, rt))?.name) || ref.id)}`;
        else if (ref.kind === 'solve') step = `Start ${quoted((await runOf(projectId, simId, ref.id, rt))?.name || ref.id)}`;
      } catch {
        step = ref.job_id;
      }
      steps.push(step);
      labels[raw] = step;
    }
    return { steps, labels };
  }

  /**
   * A card's words for the chained steps after its own (`first` names it), the "Steps" row and
   * the labels the grant keeps: every step a card's Allow covers is on the card (a chain the
   * card does not name is not granted, runner.ts).
   */
  function withChain(a: Assessed, first: string, steps: readonly string[], labels: Record<string, string>): Assessed {
    if (!steps.length) return a;
    const list = steps.map((s, i) => `${i + 2}. ${s}.`).join(' ');
    return {
      ...a,
      note: `${a.note} Covers these steps, each once: 1. ${first}. ${list} Nothing else is covered; you can stop any of them from the tree.`.trim(),
      detail: [{ label: 'Steps', value: [first, ...steps].join(', then ') }, ...a.detail].slice(0, 6),
      labels,
    };
  }

  /** The card's facts and its risk (C3: raise-only; never lower than the call's base). */
  async function escalate(input: Record<string, unknown>, rt: AssessContext): Promise<Assessed | null> {
    const action = str(input.action) as Action;
    const estimate = num(input.estimate_minutes) ?? 0;
    const estimateRow: GateDetail[] = estimate > 0 ? [{ label: "Assistant's estimate", value: `about ${Math.round(estimate)} min` }] : [];
    if (action === 'queue_kick') return null;
    if (action === 'hardware_check') return { risk: 'compute', note: 'Reads the processor count, memory and the OpenFOAM install (about a minute).', detail: [] };
    if (action === 'plugin_env_install') {
      const key = cleanText(str(input.plugin), 64);
      return {
        risk: 'compute',
        note: `Downloads and installs the Python packages ${key} needs, into its own folder. It can take several minutes.`,
        detail: [{ label: 'Plugin', value: key }],
      };
    }
    const projectId = str(input.project_id) || rt.ctx.projectId || '';
    // Whatever it can't read, a call that starts work still asks.
    const plain: Assessed = { risk: 'compute', note: '', detail: estimateRow };
    if (!projectId) return plain;
    const runCtx = { signal: rt.signal, ctx: rt.ctx, turn: rt.turn, progress: () => {} } as unknown as ToolRunContext;
    const study = await studyFor(call, projectId, input, runCtx);
    if (!study) return plain;
    const title = await projectTitle(call, projectId, rt);
    const chain = Array.isArray(input.chain) ? input.chain.map(String).filter((c) => parseJobId(c)) : [];
    const { steps, labels } = chain.length ? await chainSteps(projectId, study.id, chain, rt) : { steps: [], labels: {} };

    if (action === 'mesh_generate') {
      const mesh = await meshOf(projectId, study.id, str(input.mesh_id), rt);
      if (!mesh) return plain;
      const name = text(mesh.name) || String(mesh.id);
      const live = isRecord(mesh.live_mesh_result) ? mesh.live_mesh_result : null;
      const last = meshGenerated(mesh) ? cellsWords(num(live?.n_cells) ?? num(mesh.n_cells)) || 'generated' : 'first time';
      const q = await queueNow(rt);
      const detail: GateDetail[] = [
        { label: 'Mesh', value: name },
        { label: 'Engine', value: engineOf(mesh) },
        { label: 'Last time', value: last },
        { label: 'Queue', value: queueWords(q) },
        ...estimateRow,
      ];
      if (meshGenerated(mesh)) {
        // Runs that used it lose their match.
        let used: string[] = [];
        try {
          used = (await runOf(projectId, study.id, '', rt))?.all.filter((r) => String(r.mesh_id) === String(mesh.id) && ['done', 'stopped'].includes(String(r.status))).map((r) => text(r.name) || String(r.id)) ?? [];
        } catch {
          used = [];
        }
        const note = used.length
          ? `${name} is generated and ${used.join(', ')} used it; generating again replaces it.`
          : `${name} is generated; generating again replaces it.`;
        return withChain({ risk: 'destructive', note, detail }, `Generate ${quoted(name)} again`, steps, labels);
      }
      const note = steps.length
        ? `Covers these steps, each once: 1. Generate ${quoted(name)}. ${steps.map((s, i) => `${i + 2}. ${s}.`).join(' ')} Nothing else is covered; you can stop either from the tree.`
        : `Generates ${quoted(name)} for study ${quoted(study.name)} in project ${quoted(title)}. It runs on this PC; other jobs wait in the queue.`;
      return {
        risk: 'compute',
        note,
        detail: steps.length ? [{ label: 'Steps', value: [`Generate ${quoted(name)}`, ...steps].join(', then ') }, ...detail.slice(0, 4), ...estimateRow].slice(0, 6) : detail,
        ...(steps.length ? { labels } : {}),
      };
    }

    if (action === 'run_start' || action === 'run_continue') {
      const found = await runOf(projectId, study.id, str(input.run_id), rt);
      if (!found) return plain;
      const { run, name } = found;
      if (action === 'run_continue' && runConverged(run)) {
        return withChain({ risk: 'destructive', note: `${name} has converged; continuing changes its results.`, detail: [{ label: 'Run', value: name }] }, `Continue ${quoted(name)}`, steps, labels);
      }
      const iterations = num(run.endTime);
      const cores = num(run.cores);
      const settings = [iterations !== null ? `${iterations} iterations` : '', cores !== null ? `${cores} cores` : 'cores: auto'].filter(Boolean).join(', ');
      if (action === 'run_continue') {
        const more = num(input.extra_iterations) ?? 0;
        const to = num(input.end_time) ?? 0;
        return withChain(
          { risk: 'compute', note: more > 0 ? `Runs ${quoted(name)} for ${more} more iterations.` : `Runs ${quoted(name)} on to t = ${to} s.`, detail: [{ label: 'Run', value: name }, ...estimateRow] },
          `Continue ${quoted(name)}`,
          steps,
          labels,
        );
      }
      let meshName = text(run.mesh_name) || '';
      if (!meshName && str(run.mesh_id)) meshName = text((await meshOf(projectId, study.id, str(run.mesh_id), rt).catch(() => null))?.name) || String(run.mesh_id);
      const q = await queueNow(rt);
      const detail: GateDetail[] = [
        { label: 'Run', value: name },
        { label: 'Mesh', value: meshName || 'the study\'s mesh' },
        { label: 'Cores', value: cores !== null ? String(cores) : 'Auto' },
        { label: 'Queue', value: queueWords(q) },
        ...estimateRow,
      ];
      return withChain({ risk: 'compute', note: `Starts ${quoted(name)} of study ${quoted(study.name)}${settings ? ` (${settings})` : ''}.`, detail }, `Start ${quoted(name)}`, steps, labels);
    }

    if (action === 'vtk_export') {
      const found = await runOf(projectId, study.id, str(input.run_id), rt);
      if (!found) return plain;
      const saved = num(found.run.n_saved_times);
      const at = num(input.time);
      const frames =
        str(input.frames) === 'all' ? (saved ? `all ${saved} times` : 'every saved time') : at !== null && at >= 0 ? `t = ${at}` : 'the latest saved time';
      return {
        risk: 'compute',
        note: `Writes a VTK file of ${quoted(found.name)} (${frames}) in the project; you download it from the Assistant panel.`,
        detail: [{ label: 'Frames', value: frames }],
      };
    }
    return plain;
  }

  function gateText(input: Record<string, unknown>, a: Assessed | null): { title: string; copy: string; detail?: GateDetail[] } {
    const action = str(input.action) as Action;
    const chained = Array.isArray(input.chain) && input.chain.length > 0;
    const name = a?.detail.find((d) => d.label === 'Mesh' || d.label === 'Run')?.value ?? '';
    let title = 'Allow the Assistant to start a computation?';
    const named = chained && !!a?.labels && Object.keys(a.labels).length > 0;
    if (a?.risk === 'destructive') {
      title =
        action === 'run_continue'
          ? `Allow the Assistant to continue ${quoted(name || 'the run')} past convergence${named ? ', and the steps after it' : ''}?`
          : `Allow the Assistant to generate ${quoted(name || 'the mesh')} again${named ? ', and the steps after it' : ''}?`;
    } else if (action === 'mesh_generate') title = chained ? 'Allow the Assistant to mesh and run?' : 'Allow the Assistant to generate a mesh?';
    else if (action === 'run_start') title = chained ? 'Allow the Assistant to run these steps?' : 'Allow the Assistant to start a run?';
    else if (action === 'run_continue') title = 'Allow the Assistant to continue a run?';
    else if (action === 'vtk_export') title = 'Allow the Assistant to export results?';
    else if (action === 'hardware_check') title = 'Allow the Assistant to check this PC?';
    else if (action === 'plugin_env_install') title = `Allow the Assistant to install ${cleanText(str(input.plugin), 64) || 'a plugin'}'s tools?`;
    return { title, copy: a?.note || 'It runs on this PC; other jobs wait in the queue.', ...(a?.detail.length ? { detail: a.detail.slice(0, 6) } : {}) };
  }

  const started = (job: { kind: JobKind; id: string; name: string; project_id: string; simulation_id: string }, turn: string | null, state: 'running' | 'queued' | 'done') => {
    const jobId = job.kind === 'hw' ? 'hw.check' : jobIdOf(job.kind, job.id);
    rememberJob(turn, { ...job, job_id: jobId, since: new Date((deps.now ?? Date.now)()).toISOString(), last: state });
    return jobId;
  };

  const answer = (done: string, jobId: string, state: string, position: number, detail: Record<string, unknown> = {}): ToolOutcome => ({
    ok: true,
    data: { done, job_id: jobId, state, position, hint: jobId ? `Follow it with wait {job_ids:["${jobId}"]}` : '', detail },
    summary: done,
  });

  async function meshGenerate(projectId: string, input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
    const study = await studyFor(call, projectId, input, rt);
    if (!study) return fail('not_found', 'That study is not in this project.', "read_setup {what:'study'} lists them.");
    const mesh = await meshOf(projectId, study.id, str(input.mesh_id), rt);
    if (!mesh) return fail('not_found', str(input.mesh_id) ? 'That mesh is not in this study.' : 'This study has no mesh yet.', "read_setup {what:'meshes'} lists them; setup_edit {kind:'mesh', action:'add'} adds one.");
    const meshId = String(mesh.id);
    const name = text(mesh.name) || meshId;
    let r: Record<string, unknown>;
    try {
      r = await call(
        'mesh.generate',
        { project_id: projectId, simulation_id: study.id, mesh_id: meshId, geometry_id: study.geometryId, name },
        o(rt),
      );
    } catch (err) {
      if (err instanceof HostCallError && err.status === 409 && /already running/i.test(err.message)) {
        const jobId = started({ kind: 'mesh', id: meshId, name, project_id: projectId, simulation_id: study.id }, rt.turn, 'running');
        return answer(`${name} is already generating`, jobId, 'running', 0);
      }
      return failedCall(err);
    }
    const queued = r.queued === true;
    const item = isRecord(r.item) ? r.item : null;
    const position = queued ? num(rows(r.items).find((x) => String(x.id) === String(item?.id))?.position) ?? 0 : 0;
    const jobId = started({ kind: 'mesh', id: meshId, name, project_id: projectId, simulation_id: study.id }, rt.turn, queued ? 'queued' : 'running');
    emitSync(deps, rt, { project_id: projectId, simulation_id: study.id, kinds: ['mesh'], ids: { mesh: [meshId] }, revs: {}, tool: 'compute.mesh_generate' });
    const detail: Record<string, unknown> = {};
    if (typeof r.job_id === 'string' && r.job_id) detail.engine_job = cleanText(r.job_id, 60);
    if (item?.id) detail.queue_row = cleanText(String(item.id), 60);
    return answer(queued ? `${name} is queued (number ${position || '?'} in line)` : `${name} is generating`, jobId, queued ? 'queued' : 'running', position, detail);
  }

  async function runStart(projectId: string, input: Record<string, unknown>, rt: ToolRunContext, cont: boolean): Promise<ToolOutcome> {
    const study = await studyFor(call, projectId, input, rt);
    if (!study) return fail('not_found', 'That study is not in this project.', "read_setup {what:'study'} lists them.");
    const found = await runOf(projectId, study.id, str(input.run_id), rt);
    if (!found) return fail('not_found', str(input.run_id) ? 'That run is not in this study.' : 'This study has no run yet.', "read_setup {what:'runs'} lists them; setup_edit {kind:'run', action:'add'} adds one.");
    const { run, id: runId, name } = found;
    const more = num(input.extra_iterations) ?? 0;
    const to = num(input.end_time) ?? 0;
    if (cont && !(more > 0) && !(to > 0)) return fail('bad_values', 'run_continue needs extra_iterations (a steady run) or end_time (a transient one).', '', [{ key: 'extra_iterations', problem: 'give one of extra_iterations or end_time' }]);
    // The run's mesh: its own, else the study's active one (as the page resolves it).
    let meshId = str(run.mesh_id);
    let mesh: Record<string, unknown> | null = null;
    try {
      mesh = await meshOf(projectId, study.id, meshId, rt);
      if (!meshId && mesh) meshId = String(mesh.id);
    } catch {
      mesh = null;
    }
    const q = await call('queue.get', { project_id: projectId }, o(rt));
    const live = isRecord(q.live) ? q.live : null;
    const meshQueued = rows(q.items).some((x) => x.kind === 'mesh' && String(x.mesh_id) === meshId);
    const meshRunning = !!live && live.kind === 'mesh' && String(live.mesh_id) === meshId;
    if (!cont && (!mesh || (!meshGenerated(mesh) && !meshQueued && !meshRunning))) {
      const meshName = text(mesh?.name) || 'its mesh';
      return fail('not_ready', `${name} can't start: ${quoted(meshName)} is not generated.`, 'compute mesh_generate first, or chain both: compute {action:"mesh_generate", chain:["solve.<run_id>"]}.');
    }
    // A run with no mesh of its own takes the one it starts on, as the page's Start does
    // (runtime.js rememberRunMesh): the start route reads the run's own mesh, and without one
    // falls back to an active mesh that may not be this study's ("Generated mesh case missing").
    if (!cont && !str(run.mesh_id) && meshId) {
      try {
        await call('run.update', { project_id: projectId, simulation_id: study.id, run_id: runId, changes: { mesh_id: meshId }, base_rev: typeof run.rev === 'number' ? run.rev : undefined }, o(rt));
      } catch (err) {
        return failedCall(err);
      }
    }
    const startId = `ai-${newId()}`;
    const remember = (state: 'running' | 'queued') => started({ kind: 'solve', id: runId, name, project_id: projectId, simulation_id: study.id }, rt.turn, state);
    const sync = () => emitSync(deps, rt, { project_id: projectId, simulation_id: study.id, kinds: ['runs'], ids: { run: [runId] }, revs: {}, tool: `compute.${cont ? 'run_continue' : 'run_start'}` });
    try {
      await call(
        cont ? 'run.continue' : 'run.start',
        {
          project_id: projectId,
          simulation_id: study.id,
          run_id: runId,
          start_id: startId,
          ...(cont ? (more > 0 ? { extra_iterations: more } : { end_time: to }) : {}),
        },
        o(rt),
      );
    } catch (err) {
      const code = err instanceof HostCallError ? err.appCode : null;
      if (err instanceof HostCallError && err.status === 409 && code === 'same_run') {
        const jobId = remember('running');
        return answer(`${name} is already running`, jobId, 'running', 0);
      }
      if (err instanceof HostCallError && err.status === 409 && code === 'busy') {
        // The compute slot is taken: queued as the page queues it (runtime.js enqueueSolveJob).
        let added: Record<string, unknown>;
        try {
          added = await call(
            'queue.add',
            {
              id: `q-${newId()}`,
              mesh_id: meshId,
              run_id: runId,
              simulation_id: study.id,
              project_id: projectId,
              name,
              mesh_generating: meshRunning,
              ...(cont ? { continue: more > 0 ? { extra_iterations: more } : { end_time: to } } : {}),
            },
            o(rt),
          );
        } catch (e2) {
          return failedCall(e2);
        }
        const item = isRecord(added.item) ? added.item : null;
        const position = num(rows(added.items).find((x) => String(x.id) === String(item?.id))?.position) ?? 0;
        const jobId = remember('queued');
        sync();
        return answer(`${name} is queued (number ${position || '?'} in line)`, jobId, 'queued', position, item?.id ? { queue_row: cleanText(String(item.id), 60) } : {});
      }
      if (err instanceof HostCallError && err.code === 'aborted') {
        return fail('stopped', `Stopped while ${name} was starting; it may or may not have started.`, `Check with wait {job_ids:["solve.${runId}"]}.`);
      }
      const out = failedCall(err);
      if (out.error && err instanceof HostCallError && err.status === 400) out.error.code = 'not_ready';
      return out;
    }
    const jobId = remember('running');
    sync();
    return answer(cont ? `${name} continues` : `${name} started`, jobId, 'running', 0);
  }

  async function vtkExport(projectId: string, input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
    const study = await studyFor(call, projectId, input, rt);
    if (!study) return fail('not_found', 'That study is not in this project.', "read_setup {what:'study'} lists them.");
    const found = await runOf(projectId, study.id, str(input.run_id), rt);
    if (!found) return fail('not_found', 'That run is not in this study.', "read_setup {what:'runs'} lists them.");
    // The case folder goes from the app to the app; the model never sees it.
    const caseDir = typeof found.run.case_dir === 'string' ? found.run.case_dir : '';
    if (!caseDir) return fail('no_results', `${found.name} has no results yet; its status is ${text(found.run.status, 40) || 'draft'}.`);
    const frames = str(input.frames) === 'all' ? 'all' : 'current';
    let time = '';
    if (frames === 'current') {
      let times: string[] = [];
      try {
        const t = await call('results.times', { case: caseDir, project_id: projectId }, o(rt));
        times = Array.isArray(t.times) ? t.times.map(String) : [];
      } catch (err) {
        if (err instanceof HostCallError && err.status === 404) return fail('no_results', `${found.name} has no saved times yet.`);
        return failedCall(err);
      }
      if (!times.length) return fail('no_results', `${found.name} has no saved times yet.`);
      const want = num(input.time);
      if (want === null || want < 0) time = times[times.length - 1];
      else {
        const hit = times.find((t) => Number(t) === want);
        if (!hit) return fail('bad_values', `${found.name} has no saved time ${want}.`, `Saved times: ${times.slice(-12).join(', ')}`, [{ key: 'time', problem: 'not a saved time' }]);
        time = hit;
      }
    }
    let r: Record<string, unknown>;
    try {
      r = await call('export.start', { project_id: projectId, case: caseDir, frames, time }, o(rt));
    } catch (err) {
      return failedCall(err);
    }
    const job = text(r.job_id, 60);
    if (!/^job-/.test(job)) return fail('app_error', 'The export did not start.');
    const jobId = started({ kind: 'export', id: job, name: `${found.name} export`, project_id: projectId, simulation_id: study.id }, rt.turn, 'running');
    return answer(`Exporting ${found.name} (${frames === 'all' ? 'all saved times' : `t = ${time}`})`, jobId, 'running', 0);
  }

  return {
    name: 'compute',
    localName: 'compute',
    title: 'Start a computation',
    description: DESCRIPTION,
    schema: COMPUTE_SCHEMA,
    // escalate raises every action but queue_kick (which starts only what was approved and
    // queued) to a compute card, or a destructive one; a failed escalate asks as destructive.
    risk: 'edit',
    source: { kind: 'host' },
    projectData: true,
    stallMs: HOST_STALL_MS,
    workerBacked: false,
    priority: 84,
    contexts: COMPUTE_CONTEXTS,
    available: () => true,
    escalate,
    gateText,
    chainKey: computeChainKey,
    projectOf: (input: Record<string, unknown>, ctx: ToolCtx) => (NO_PROJECT.has(str(input.action)) ? null : str(input.project_id) || ctx.projectId),
    describe(input: Record<string, unknown>) {
      return { line: `compute ${cleanText(str(input.action), 40)}` };
    },
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const action = str(input.action) as Action;
      const chain = Array.isArray(input.chain) ? input.chain : [];
      const badChain = chain.filter((c) => {
        const ref = parseJobId(c);
        return !ref || (ref.kind !== 'mesh' && ref.kind !== 'solve');
      });
      if (badChain.length) {
        return fail('bad_values', 'chain lists only mesh.<mesh_id> and solve.<run_id> job ids.', '', badChain.slice(0, 12).map((c) => ({ key: 'chain', problem: `${cleanText(String(c), 100)} is not a mesh or solve job id` })));
      }
      try {
        if (action === 'hardware_check') {
          const r = await withHeartbeat(rt, 'Checking this PC', call('prefs.hardware_check', {}, o(rt)));
          const hw = isRecord(r.hardware) ? r.hardware : {};
          const jobId = started({ kind: 'hw', id: 'check', name: 'This PC check', project_id: '', simulation_id: '' }, rt.turn, 'done');
          return answer('Checked this PC', jobId, 'done', 0, {
            cores: num(hw.physical_cores),
            logical_cpus: num(hw.logical_cpus),
            ram_gb: num(hw.ram_gb),
            disk_free_gb: num(hw.disk_free_gb),
            openfoam: hw.openfoam_ok === true ? 'ok' : 'missing',
            solver_ranks: num(hw.n_procs),
            profile: text(hw.profile, 40),
          });
        }
        if (action === 'plugin_env_install') {
          const key = str(input.plugin);
          if (!PLUGIN_KEY.test(key)) return fail('bad_values', 'plugin_env_install needs the plugin key.', "catalog {kind:'plugins'} lists them.", [{ key: 'plugin', problem: 'not a plugin key' }]);
          const r = await call('plugins.env.install', { key }, o(rt));
          const st = isRecord(r.install) ? String(r.install.state ?? '') : String(r.state ?? '');
          const jobId = started({ kind: 'env', id: key, name: `${key} tools`, project_id: '', simulation_id: '' }, rt.turn, st === 'ready' ? 'done' : 'running');
          return answer(st === 'ready' ? `${key}'s tools are installed` : `Installing ${key}'s tools`, jobId, st === 'ready' ? 'done' : 'running', 0);
        }
        const project = writeProject(input, rt.ctx);
        if (!project.ok) return project.out;
        if (action === 'queue_kick') {
          await call('queue.kick', { project_id: project.id }, o(rt));
          return answer('Asked the queue to start its next job', '', 'running', 0);
        }
        if (action === 'mesh_generate') return await meshGenerate(project.id, input, rt);
        if (action === 'run_start') return await runStart(project.id, input, rt, false);
        if (action === 'run_continue') return await runStart(project.id, input, rt, true);
        if (action === 'vtk_export') return await vtkExport(project.id, input, rt);
        return fail('invalid_input', `Unknown action ${cleanText(String(action), 40)}.`);
      } catch (err) {
        return failedCall(err);
      }
    },
  };
}
