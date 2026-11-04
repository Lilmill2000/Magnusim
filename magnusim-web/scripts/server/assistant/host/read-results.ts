/**
 * read_results (Core host tools spec 4.7): a run's numbers as the results panels show them:
 * its status and residuals, its monitors, the saved times, a field's range, values at
 * points and along a line, a plugin filter's answer, its pictures and recordings, the
 * exports this turn started, and the time step a transient run would take.
 *
 * The case folder: read from the run's own status and passed as `case` with project_id,
 * so the results routes check it is this project's. It never reaches the model, and
 * /api/case/attach (the server-wide attached case) is never called.
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { scrubContext, scrubText } from '../../../solver-log-scrub.js';
import { NOT_CHECKED, chipWord, earlierPartLines, healthNextWords, noRecordWords, type HealthRecord } from '../../../../src/workbench/runHealthWords.ts';
import { pendingContinue, runEditState, valuesBeforeContinue } from '../../../../src/workbench/runReopen.ts';
import { runFields } from './catalog.ts';
import {
  badValues,
  fail,
  failed,
  flattenSchema,
  hostTool,
  isRecord,
  nest,
  num,
  objectSchema,
  offeredIn,
  okData,
  parseValues,
  projectIdOf,
  quoted,
  readableProject,
  records,
  refuse,
  S,
  str,
  studyIdOf,
  text,
  via,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';

export const RESULT_KINDS = ['status', 'residuals', 'monitors', 'times', 'field_range', 'point', 'line', 'plugin_filter', 'media', 'exports', 'transient_preview', 'health', 'log_tail'] as const;
/** RH1: the most a `health` and a `log_tail` answer carries. */
export const HEALTH_ANSWER_MAX = 8 * 1024;
export const LOG_TAIL_MAX = 24 * 1024;
const SERIES_MAX = 200;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Every `n`th of `list`, so at most `max` remain (the last always kept). */
export function thin<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const step = (list.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
  return out;
}

const PATHISH_KEY = /(^|_)(path|dir|file|url|vtu|vtp|foam|root)s?$|^case$|^log/i;
const PATHISH_TEXT = /([A-Za-z]:[\\/])|(\\\\)|(^|\s)\/(home|Users|mnt|tmp|var|root)\//;

/** Plain JSON from an app answer with every path-like key and value left out. */
export function noPaths(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, SERIES_MAX).map((x) => noPaths(x, depth + 1));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (PATHISH_KEY.test(k)) continue;
      if (typeof x === 'string' && PATHISH_TEXT.test(x)) continue;
      out[k] = noPaths(x, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') return cleanText(v, 300);
  return v;
}

export function readResultsTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench'] as const;
  return hostTool({
    name: 'read_results',
    title: 'Read the results',
    description:
      'A run\'s numbers: status, residuals, monitors, times, field_range, point, line, plugin_filter, media, exports, transient_preview, health, log_tail. "" = this window\'s project, the shown study, its active run; time -1 = latest; unused: "", [], 0.',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      simulation_id: S.id('"" = the study shown'),
      run_id: S.id('"" = the study\'s active run'),
      kind: S.enum(RESULT_KINDS),
      field: S.text(80, 'e.g. U, p, T; "" when unused'),
      time: { type: 'number', description: '-1 = the latest written time; log_tail: -1 end, 0 start, or a finding\'s log_at' },
      points: {
        type: 'array',
        maxItems: 64,
        description: 'point: 1..64 points; line: exactly 2 (start, end)',
        items: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      },
      samples: { type: 'integer', minimum: 0, maximum: 2000, description: 'line: samples along it; log_tail: lines (max 200); 0 = 100' },
      filter_key: S.text(80, 'plugin_filter: the filter (catalog filters); log_tail: "" or "issues"'),
      values: S.values(24, 400, 'plugin_filter: its fields; transient_preview: transient.* keys. Each value is JSON text.'),
    }),
    risk: 'read',
    projectData: true,
    priority: 76,
    workerBacked: true,
    contexts,
    available: offeredIn(contexts),
    projectOf: (input, ctx) => projectIdOf(input, ctx),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const kind = str(input.kind);
      const tool = `read_results.${kind}`;
      const o = via(rt, tool);
      try {
        const project = await readableProject(input, rt.ctx, d);
        const { id: sim, studies } = await studyIdOf(input, rt.ctx, project, d.hostCall, rt, tool);
        const status = (await d.hostCall('run.status', { project_id: project, simulation_id: sim, run_id: str(input.run_id) }, o)) as Record<string, unknown>;
        const run = isRecord(status.run) ? status.run : null;
        const wanted = str(input.run_id).trim();
        if (!run || (wanted && run.id !== wanted && run.run_id !== wanted)) {
          return fail('not_found', wanted ? `No run "${cleanText(wanted, 80)}" in this study.` : 'This study has no run yet.', "read_setup {what:'runs'} lists them.");
        }
        const runId = str(run.id ?? run.run_id);
        const runName = str(run.name) || 'The run';
        const caseDir = str(run.case_dir);
        const noResults = () =>
          fail('no_results', `${runName} has no results yet; its status is ${str(run.status) || 'draft'}.`, "compute {action:'run_start'} runs it.");
        switch (kind) {
          case 'status': {
            let position: number | null = null;
            try {
              const q = (await d.hostCall('queue.get', { project_id: project }, o)) as Record<string, unknown>;
              position = num(records(q.items).find((r) => r.kind === 'solve' && r.run_id === runId)?.position);
            } catch {
              position = null;
            }
            return okData(
              {
                run_id: runId,
                name: text(runName),
                status: text(run.status ?? 'draft', 20),
                phase: text(run.stage, 40),
                iteration: num(run.iteration),
                end: num(run.endTime),
                time: num(run.sim_time),
                eta_s: num(run.eta_s),
                converged: isRecord(run.converged) ? noPaths(run.converged) : run.converged === false ? false : null,
                cores: num(run.n_procs) ?? num(run.cores),
                started_at: text(run.started_at, 40),
                finished_at: text(run.finished_at, 40),
                error: text(run.error, 500),
                has_results: run.has_results === true,
                saved_times: num(run.n_saved_times),
                queue_position: position,
                // RH1 (R22): the run panel's line, and its health.
                courant: num(run.co_max) !== null ? { mean: num(run.co_mean), max: num(run.co_max) } : null,
                delta_t: num(run.delta_t),
                n_steps: num(run.n_steps),
                cells: num(isRecord(run.mesh_source) ? run.mesh_source.n_cells : null),
                stopping: run.stop_requested === true && ['running', 'starting'].includes(str(run.status)),
                warnings: statusWarnings(run.warnings),
                health: healthSummary(run.health),
                health_checked: typeof run.health_checked === 'boolean' ? run.health_checked : null,
              },
              `${runName}: ${str(run.status) || 'draft'}${isRecord(run.health) && typeof run.health.verdict === 'string' ? ` · health ${String(run.health.verdict)}` : ''}`,
            );
          }
          case 'health': {
            // Its study's mode now: "Use when continuing" only where the person's panel offers it.
            const study = studies.list.find((s) => s.id === sim);
            const studyTransient = study ? /transient/i.test(str(study.time_dependency)) : null;
            return await healthAnswer(d, rt, o, { project, sim, runId, runName, run, studyTransient });
          }
          case 'log_tail':
            return await logTail(d, o, { project, sim, runId, run, input });
          case 'residuals': {
            const rows = records(run.residuals);
            if (!rows.length) return noResults();
            const keys = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 't' && typeof r[k] === 'number')))].slice(0, 24);
            const last = rows[rows.length - 1];
            const series: Record<string, Array<[number, number]>> = {};
            for (const k of keys) {
              series[k] = thin(
                rows.filter((r) => typeof r[k] === 'number').map((r) => [Number(r.t), Number(r[k])] as [number, number]),
                SERIES_MAX,
              );
            }
            const lastValues: Record<string, unknown> = {};
            for (const k of keys) if (typeof last[k] === 'number') lastValues[k] = last[k];
            return okData({ run_id: runId, x: num(last.t), last: lastValues, series }, `${runName}: ${keys.length} residual series`);
          }
          case 'monitors': {
            const m = (await d.hostCall('run.monitors', { project_id: project, simulation_id: sim, run_id: runId }, o)) as Record<string, unknown>;
            const thinRows = (v: unknown) => (Array.isArray(v) ? thin(v, SERIES_MAX) : v);
            const monitors = records(m.monitors).map((x) => noPaths({ ...x, ...(Array.isArray(x.rows) ? { rows: thinRows(x.rows) } : {}), ...(Array.isArray(x.series) ? { series: thinRows(x.series) } : {}) }));
            return okData(
              {
                run_id: runId,
                status: text(m.status, 20),
                transient: m.transient === true,
                monitors,
                custom: noPaths(records(m.custom)),
                summary: noPaths(m.summary ?? null),
                balance: noPaths(m.balance ?? null),
                ...(Array.isArray(m.rows) ? { rows: noPaths(thin(m.rows, SERIES_MAX)) } : {}),
                unavailable: text(m.unavailable, 300),
              },
              `${runName}: ${monitors.length} monitors`,
            );
          }
          case 'transient_preview': {
            const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
            const study = studies.list.find((s) => s.id === sim) ?? {};
            const fields = runFields(registry, str(study.analysis_type)).filter((f) => f.key.startsWith('transient.'));
            const parsed = parseValues(input.values, fields);
            if (!parsed.ok) return badValues(parsed.problems, "catalog {kind:'analyses', key} lists the transient.* fields.");
            const transient = isRecord(nest(parsed.values).transient) ? (nest(parsed.values).transient as Record<string, unknown>) : {};
            const pv = (await d.hostCall('run.transient_preview', { project_id: project, simulation_id: sim, run_id: runId, transient }, o)) as Record<string, unknown>;
            return okData(noPaths(pv), `${runName}: transient preview`);
          }
          case 'media': {
            const list = (await d.hostCall('media.list', { project_id: project, simulation_id: sim, owner: `run-${runId}` }, o)) as Record<string, unknown>;
            const items = records(list.items).slice(0, 100).map((m) => ({
              id: text(m.id, 80),
              kind: text(m.kind, 20),
              name: text(m.name),
              width: num(m.width),
              height: num(m.height),
              duration_s: num(m.duration_s),
              created_at: text(m.created_at, 40),
            }));
            return okData({ owner: `run-${runId}`, items }, `${items.length} pictures and recordings`);
          }
          case 'exports': {
            const ids = d.knownExports ? d.knownExports(rt.turn) : [];
            const exports = [];
            for (const id of ids.slice(0, 10)) {
              try {
                const e = (await d.hostCall('results.export', { project_id: project, id }, o)) as Record<string, unknown>;
                exports.push({ job_id: `export.${id}`, status: text(e.status, 20), fraction: num(e.fraction), message: text(e.message, 300) });
              } catch {
                exports.push({ job_id: `export.${id}`, status: 'unknown' });
              }
            }
            return okData({ exports }, `${exports.length} exports`);
          }
          default:
            break;
        }
        // The rest read the case's files.
        if (!caseDir) return noResults();
        const at = { project_id: project, case: caseDir };
        const times = (await d.hostCall('results.times', at, o)) as Record<string, unknown>;
        const list = Array.isArray(times.times) ? times.times.map((t) => String(t)) : [];
        if (kind === 'times') {
          return okData({ run_id: runId, times: list.slice(-500), fields_available: Array.isArray(times.fields_available) ? times.fields_available : [] }, `${list.length} saved times`);
        }
        if (!list.length) return noResults();
        const time = timeOf(input.time, list);
        const field = str(input.field).trim();
        if (kind === 'field_range') {
          if (!FIELD_NAME.test(field)) return fail('invalid_input', 'field_range needs a field, e.g. "p" or "U".', "read_results {kind:'times'} lists fields_available.");
          const meta = (await d.hostCall('results.field_meta', { ...at, field, time }, o)) as Record<string, unknown>;
          const proof = isRecord(meta.foam_proof) ? meta.foam_proof : {};
          const surface = isRecord(meta.surface_field) ? meta.surface_field : {};
          let overAll: Record<string, unknown> | null = null;
          try {
            const series = (await d.hostCall('results.series_range', { ...at, field }, o)) as Record<string, unknown>;
            if (series.ok !== false) overAll = { min: num(series.min), max: num(series.max) };
          } catch {
            overAll = null;
          }
          const resultFields = records(meta.result_fields);
          const unit = text(resultFields.find((f) => f.key === field || f.name === field)?.unit ?? meta.pressure_range_unit ?? '', 20);
          return okData(
            { field, time, min: num(proof.min) ?? num(surface.min), max: num(proof.max) ?? num(surface.max), mean: num(proof.mean), unit, over_all_times: overAll },
            `${field} at ${time}: ${num(proof.min) ?? num(surface.min)} to ${num(proof.max) ?? num(surface.max)}`,
          );
        }
        if (kind === 'point') {
          const points = Array.isArray(input.points) ? input.points : [];
          if (!points.length) return fail('invalid_input', 'point needs 1 to 64 points, each [x, y, z] in metres.');
          const out = [];
          for (const [i, p] of points.entries()) {
            rt.progress(i / points.length, `Probing point ${i + 1} of ${points.length}`);
            const [x, y, z] = (p as number[]).map(Number);
            const r = (await d.hostCall('results.inspect', { ...at, time, x, y, z, fields: field }, o)) as Record<string, unknown>;
            const values: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(isRecord(r.values) ? r.values : {}).slice(0, 40)) values[cleanText(k, 64)] = typeof v === 'number' || v === null ? v : Array.isArray(v) ? v.slice(0, 9) : null;
            out.push({ x, y, z, values, inside: r.hit === true });
          }
          return okData({ time, points: out }, `${out.length} points at ${time}`);
        }
        if (kind === 'line') {
          const points = Array.isArray(input.points) ? input.points : [];
          if (points.length !== 2) return fail('invalid_input', 'line needs exactly 2 points: its start and its end, each [x, y, z] in metres.');
          const samples = Number(input.samples) > 0 ? Math.min(2000, Number(input.samples)) : 100;
          const encoded = (points as number[][]).map((p) => p.map(Number).join(',')).join(';');
          const r = (await d.hostCall('results.line', { ...at, time, points: encoded, subdivisions: samples, field }, o)) as Record<string, unknown>;
          const dist = Array.isArray(r.distances) ? r.distances : [];
          const vals = Array.isArray(r.values) ? r.values : [];
          const at3 = Array.isArray(r.sample_points) ? r.sample_points : [];
          const rows = dist.slice(0, 2000).map((s, i) => {
            const pt = Array.isArray(at3[i]) ? (at3[i] as unknown[]) : [];
            return { s: num(s), x: num(pt[0]), y: num(pt[1]), z: num(pt[2]), value: typeof vals[i] === 'number' ? vals[i] : null };
          });
          return okData(
            { field: text(r.field_name ?? r.field ?? field, 64), time, samples: rows, min: num(r.value_min), max: num(r.value_max), mean: num(r.value_mean), reason: text(r.reason, 40) },
            `${rows.length} samples along the line`,
          );
        }
        if (kind === 'plugin_filter') {
          const key = str(input.filter_key).trim();
          const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
          const row = records(registry.filter).find((f) => f.key === key);
          if (!row) return fail('not_found', `No filter "${cleanText(key, 80)}".`, "catalog {kind:'filters', key:''} lists them.");
          const parsed = parseValues(input.values, flattenSchema(row.schema));
          if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'filters', key:'${cleanText(key, 80)}'} lists its fields.`);
          const params: Record<string, string> = { time };
          if (field) params.field = field;
          for (const [k, v] of Object.entries(parsed.values)) params[k] = Array.isArray(v) || isRecord(v) ? JSON.stringify(v) : String(v);
          const r = (await d.hostCall('results.filter', { project_id: project, simulation_id: sim, case: caseDir, key, params }, o)) as Record<string, unknown>;
          return okData({ filter: key, answer: noPaths(r) }, `Filter ${key}`);
        }
        return fail('invalid_input', `Unknown kind "${cleanText(kind, 40)}".`);
      } catch (err) {
        return failed(err);
      }
    },
  });
}

/** A run's warnings as read_results status gives them: scrubbed, at most 10. */
function statusWarnings(raw: unknown): Array<{ code: string; message: string; scrubbed: true }> {
  const ctx = scrubContext();
  return records(raw)
    .slice(0, 10)
    .map((w) => ({ code: text(w.code, 40) || '', message: scrubText(str(w.message), ctx, 300), scrubbed: true as const }));
}

/** What read_results status says of a run's health: its verdict, its finding codes and where Continue would go on from. */
function healthSummary(raw: unknown): { verdict: string; codes: string[]; restart: string | null } | null {
  if (!isRecord(raw) || typeof raw.verdict !== 'string') return null;
  return {
    verdict: raw.verdict,
    codes: records(raw.findings)
      .map((f) => text(f.code, 40) || '')
      .slice(0, 6),
    restart: typeof raw.restart === 'string' ? raw.restart : null,
  };
}

type Ctx = { project: string; sim: string; runId: string; runName: string; run: Record<string, unknown>; studyTransient: boolean | null };

/**
 * The view of the run the Health words read (the same as the Run panel's). `studyTransient`: its
 * study's mode now, when known (a change waits for Continue only where runEditState says so).
 */
function runView(run: Record<string, unknown>, name: string, studyTransient: boolean | null = null) {
  const status = str(run.status);
  const raw = run.continue_from ?? (num(run.last_saved_iteration) && Number(run.last_saved_iteration) > 0 ? run.last_saved_iteration : null);
  return {
    name,
    status,
    stopping: run.stop_requested === true && ['running', 'starting'].includes(status),
    saved: num(raw),
    transient: /transient/i.test(str(run.time_dependency)),
    continues: runEditState(run, { studyTransient }) === 'continues',
    n_steps: num(run.n_steps),
  };
}

/**
 * A fix as setup_edit's one call that makes the new run (A3: from t = 0; the run keeps its
 * results). `before`: the values the run solved with of the keys waiting for its Continue (A2,
 * runReopen.ts valuesBeforeContinue), sent ahead of the fix's own, so the new run is the one the
 * Run panel's button makes and the fix's cost describes.
 */
function fixCall(f: Record<string, unknown>, runId: string, runName: string, before: Array<{ key: string; value: unknown }> = []) {
  const own = records(f.values).map((v) => ({ key: text(v.key, 80), value: JSON.stringify(v.value ?? null) }));
  const values = [...before.filter((b) => !own.some((v) => v.key === b.key)).map((b) => ({ key: text(b.key, 80), value: JSON.stringify(b.value ?? null) })), ...own];
  const name = text(f.name, 64) || `${runName} fixed`;
  return {
    label: text(f.label, 60),
    target: text(f.target, 20),
    name,
    values,
    cost: isRecord(f.cost) ? { steps: num(f.cost.steps), wall_s: num(f.cost.wall_s) } : null,
    call: f.target === 'new_run' ? `setup_edit {kind:'run', action:'add', other_id:'${runId}', name:'${name}', values:${JSON.stringify(values)}}` : null,
  };
}

/**
 * read_results {kind:'health'} (RH1, spec 3.13): the run's health record with what to do (the
 * Run panel's words), its algorithm, earlier parts and pending changes. An ended run that ran
 * before health checks existed starts "Check its log" (a read of its own log: no card).
 */
async function healthAnswer(d: HostToolDeps, rt: ToolRunContext, o: ReturnType<typeof via>, c: Ctx): Promise<ToolOutcome> {
  const { project, sim, runId, runName, run, studyTransient } = c;
  const got = (await d.hostCall('run.health', { project_id: project, simulation_id: sim, run_id: runId }, o)) as Record<string, unknown>;
  let rec = isRecord(got.health) ? got.health : null;
  const checkedFlag = typeof got.health_checked === 'boolean' ? got.health_checked : null;
  if (!rec) {
    if (checkedFlag === false) return okData({ run_id: runId, health: null, checked: false, why: NOT_CHECKED }, `${runName}: health is not checked`);
    const ended = ['done', 'stopped', 'failed'].includes(str(run.status));
    if (ended && checkedFlag === null) {
      const again = (await d.hostCall('run.health', { project_id: project, simulation_id: sim, run_id: runId, recompute: '1' }, o)) as Record<string, unknown>;
      if (isRecord(again.health)) rec = again.health;
      else if (again.checking === true) {
        return okData({ run_id: runId, checking: true, hint: 'read_results {kind:"health"} again in a few seconds' }, `${runName}: checking its log`);
      } else return fail('no_results', text(again.error, 200) || 'Its log could not be checked.');
    } else {
      // The Run panel's words: an ended run says why it has none; a solving one is not judged yet.
      const none = ended ? noRecordWords(runView(run, runName), checkedFlag) : '';
      return okData(
        { run_id: runId, health: null, checked: true, why: none || `Not judged yet: health is judged from the 6th ${/transient/i.test(str(run.time_dependency)) ? 'time step' : 'iteration'} on.` },
        `${runName}: ${none ? 'no health record' : 'health not judged yet'}`,
      );
    }
  }
  if (!rec) return fail('no_results', 'This run has no health record.');
  const ctx = scrubContext();
  const h = rec as unknown as HealthRecord;
  const view = runView(run, runName, studyTransient);
  // The change waiting for its Continue (A2), as the Run panel's Continue box shows it.
  const pending = pendingContinue(run);
  const next = healthNextWords(view, h, pending);
  const before = valuesBeforeContinue(run);
  const findings = records(rec.findings).map((f) => ({
    code: text(f.code, 40),
    level: text(f.level, 10),
    text: scrubText(str(f.text), ctx, 240),
    evidence: isRecord(f.evidence)
      ? {
          line: num(f.evidence.line),
          log_at: num(f.evidence.log_at),
          key: text(f.evidence.key, 12),
          ...(typeof f.evidence.text === 'string' ? { text: scrubText(f.evidence.text, ctx, 200) } : {}),
        }
      : null,
    since_t: num(f.since_t),
    fix: records(f.fix).map((x) => fixCall(x, runId, runName, before)),
  }));
  const prep = isRecord(run.prepare_run) ? run.prepare_run : {};
  const turb = isRecord(prep.turbulence) ? prep.turbulence : {};
  const attempts = records(run.attempts);
  const changes = records(run.continue_changes);
  const out: Record<string, unknown> = {
    run_id: runId,
    name: text(runName),
    status: text(run.status, 20),
    verdict: text(rec.verdict, 20),
    // The chip's word: "Checking (needs 6 time steps)" while it solves, "Not judged" once it ended.
    word: chipWord(h, view.transient, ['done', 'stopped', 'failed'].includes(view.status)),
    at: text(rec.at, 40),
    step: num(rec.step),
    t: num(rec.t),
    unit: text(rec.unit, 12),
    window: num(rec.window),
    live: rec.live === true,
    ...(rec.stale ? { stale: true } : {}),
    ...(rec.head_missing ? { head_missing: true } : {}),
    mode: text(rec.mode, 10) || null,
    checked: Array.isArray(rec.checked) ? rec.checked.map((x) => text(x, 40)).slice(0, 16) : [],
    skipped: records(rec.skipped).map((x) => ({ code: text(x.code, 40), why: text(x.why, 60) })).slice(0, 8),
    courant: isRecord(rec.courant) ? rec.courant : null,
    delta_t: isRecord(rec.delta_t) ? rec.delta_t : null,
    rates: isRecord(rec.rates) ? rec.rates : null,
    first_unhealthy: isRecord(rec.first_unhealthy) ? rec.first_unhealthy : null,
    restart: typeof rec.restart === 'string' ? rec.restart : null,
    findings,
    warnings: records(rec.warnings).map((w) => ({ text: scrubText(str(w.text), ctx, 160), count: num(w.count) })).slice(0, 3),
    next: { text: next.text, stop: next.stop, fixes: next.fixes.map((f) => fixCall(f as unknown as Record<string, unknown>, runId, runName, before)) },
    algorithm: {
      solver: text(run.path_kind, 40) || null,
      turbulence: text(turb.model, 40) || null,
      cells: num(isRecord(run.mesh_source) ? run.mesh_source.n_cells : null),
      ranks: num(run.n_procs),
    },
    earlier: earlierPartLines(attempts as never, changes as never, view.transient),
    continue_changes: changes.slice(-3),
    checked_at_start: Array.isArray(prep.checks) ? records(prep.checks).map((x) => text(x.code, 40)) : null,
    shown_in: 'Run panel → Health',
  };
  // At most 8 KB: the evidence words go first, then the earlier parts, then the info findings.
  const size = () => Buffer.byteLength(JSON.stringify(out), 'utf8');
  if (size() > HEALTH_ANSWER_MAX) for (const f of findings) if (f.evidence) delete (f.evidence as Record<string, unknown>).text;
  if (size() > HEALTH_ANSWER_MAX) out.earlier = (out.earlier as string[]).slice(-1);
  if (size() > HEALTH_ANSWER_MAX) out.findings = findings.filter((f) => f.level !== 'info');
  void rt;
  return okData(out, `${runName}: ${String(out.word)} · ${findings.length} findings`);
}

/**
 * read_results {kind:'log_tail'} (RH1, spec 3.13): the run's solver output, scrubbed: the end
 * (time -1), the start (time 0), or around a finding's line (time = its evidence's log_at; the
 * finding's key finds the line when the offset drifted). filter_key "issues": the problem lines.
 */
async function logTail(d: HostToolDeps, o: ReturnType<typeof via>, c: { project: string; sim: string; runId: string; run: Record<string, unknown>; input: Record<string, unknown> }): Promise<ToolOutcome> {
  const { project, sim, runId, run, input } = c;
  const want = Number(input.samples) > 0 ? Math.min(200, Math.floor(Number(input.samples))) : 100;
  const t = Number(input.time);
  let at = 'end';
  let key = '';
  if (Number.isFinite(t) && t === 0) at = 'start';
  else if (Number.isFinite(t) && t > 0) {
    at = String(Math.floor(t));
    const hit = records(isRecord(run.health) ? run.health.findings : []).find((f) => isRecord(f.evidence) && Number(f.evidence.log_at) === Math.floor(t));
    if (hit && isRecord(hit.evidence)) key = text(hit.evidence.key, 12) || '';
  }
  const filter = str(input.filter_key).trim() === 'issues' ? 'issues' : '';
  const r = (await d.hostCall('run.solver_log', { project_id: project, simulation_id: sim, run_id: runId, lines: String(want), at, key, filter }, o)) as Record<string, unknown>;
  if (r.missing === true) return fail('no_results', 'This run has no solver output.');
  const ctx = scrubContext();
  let lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => scrubText(str(l), ctx, 240));
  let hit = num(r.hit_line);
  const out = () => ({
    run_id: runId,
    at,
    filter,
    lines,
    first_line: num(r.first_line),
    hit_line: hit,
    total_lines: num(r.total_lines),
    truncated: r.truncated === true || lines.length < (Array.isArray(r.lines) ? r.lines.length : 0),
    live: r.live === true,
    as_of: text(r.as_of, 40),
  });
  // At most 24 KB: lines leave from the end farther from the hit.
  while (lines.length > 1 && Buffer.byteLength(JSON.stringify(out()), 'utf8') > LOG_TAIL_MAX) {
    if (hit !== null && hit > lines.length / 2) {
      lines = lines.slice(1);
      hit -= 1;
    } else lines = lines.slice(0, -1);
  }
  return okData(out(), `${lines.length} lines of its solver output`);
}

/** The time to read: the given one if saved, the latest for -1; refused when not saved. */
function timeOf(raw: unknown, list: string[]): string {
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) return list[list.length - 1];
  const hit = list.find((x) => Number(x) === t);
  if (!hit) return refuse('not_found', `No results saved at time ${t}.`, `read_results {kind:'times'} lists them (${quoted(list.slice(-3).join(', '))} are the last).`);
  return hit;
}
