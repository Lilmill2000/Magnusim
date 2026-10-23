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

export const RESULT_KINDS = ['status', 'residuals', 'monitors', 'times', 'field_range', 'point', 'line', 'plugin_filter', 'media', 'exports', 'transient_preview'] as const;
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
      'A run\'s numbers: status, residuals, monitors, times, field_range, point, line, plugin_filter, media, exports, transient_preview. "" = this window\'s project, the shown study, its active run; time -1 = latest; unused: "", [], 0.',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      simulation_id: S.id('"" = the study shown'),
      run_id: S.id('"" = the study\'s active run'),
      kind: S.enum(RESULT_KINDS),
      field: S.text(80, 'e.g. U, p, T; "" when unused'),
      time: { type: 'number', description: '-1 = the latest written time' },
      points: {
        type: 'array',
        maxItems: 64,
        description: 'point: 1..64 points; line: exactly 2 (start, end)',
        items: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } },
      },
      samples: { type: 'integer', minimum: 0, maximum: 2000, description: 'line: samples along it; 0 = 100' },
      filter_key: S.text(80, 'plugin_filter: the filter (catalog filters)'),
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
              },
              `${runName}: ${str(run.status) || 'draft'}`,
            );
          }
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

/** The time to read: the given one if saved, the latest for -1; refused when not saved. */
function timeOf(raw: unknown, list: string[]): string {
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) return list[list.length - 1];
  const hit = list.find((x) => Number(x) === t);
  if (!hit) return refuse('not_found', `No results saved at time ${t}.`, `read_results {kind:'times'} lists them (${quoted(list.slice(-3).join(', '))} are the last).`);
  return hit;
}
