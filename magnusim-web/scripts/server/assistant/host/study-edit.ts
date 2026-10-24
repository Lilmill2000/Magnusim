/**
 * study_edit (Core host tools spec 4.9): a study's create, copy, rename, activate, reorder,
 * settings and time dependency, and a plugin study's create and rename, in the project
 * open in this window only. A change to the settings of a study whose runs have results
 * asks first (those results no longer match).
 *
 * Route facts the tool works around: POST /api/simulation ignores `name` (a rename
 * follows); /api/simulation/activate answers 200 to an unknown id (checked first); the
 * page made no Run 1 on create, so the tool makes one when the study has none.
 */
import type { ToolCtx, ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { studyFields } from './catalog.ts';
import {
  badValues,
  emitSync,
  failed,
  fail,
  hostTool,
  isRecord,
  nest,
  objectSchema,
  offeredIn,
  okDone,
  parseValues,
  quoted,
  records,
  refuse,
  S,
  str,
  studiesOf,
  via,
  writableProject,
  type AssessContext,
  type Assessed,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';
import { HostCallError, type HostCall } from '../host-call.ts';

export const STUDY_ACTIONS = ['create', 'copy', 'rename', 'activate', 'reorder', 'set', 'set_time', 'plugin_create', 'plugin_rename'] as const;

/** The names of a study's runs that have results (done, or stopped with saved times). */
export async function runsWithResults(call: HostCall, rt: { signal: AbortSignal; turn: string | null }, project: string, sim: string, tool: string): Promise<string[]> {
  const status = (await call('run.status', { project_id: project, simulation_id: sim }, { signal: rt.signal, turn: rt.turn, tool })) as Record<string, unknown>;
  return records(status.runs)
    .filter((r) => r.status === 'done' || r.status === 'finished' || (r.has_results === true && r.status !== 'running') || (r.status === 'stopped' && Number(r.n_saved_times) > 0))
    .map((r) => str(r.name) || str(r.id));
}

/** "Run 1", "Run 1 and Run 2", "Run 1, Run 2 and Run 3". */
export function andList(names: string[]): string {
  const q = names.map((n) => cleanText(n, 60));
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

export function resultsNote(names: string[]): string {
  return `${andList(names)} ${names.length === 1 ? 'has' : 'have'} results made with the old settings; they will no longer match these settings.`;
}

const tdOf = (v: unknown): string => (v === 'transient' ? 'Transient' : v === 'steady' ? 'Steady-state' : '');

export function studyEditTool(d: HostToolDeps): HostToolDef {
  const contexts = ['workbench'] as const;
  const assess = async (input: Record<string, unknown>, a: AssessContext): Promise<Assessed | null> => {
    if (input.action !== 'set' && input.action !== 'set_time') return null;
    const project = a.ctx.projectId;
    if (!project) return null;
    const rt = { signal: a.signal, turn: a.turn };
    const studies = await studiesOf(d.hostCall, project, rt, 'study_edit');
    const sim = str(input.id) || a.ctx.simulationId || studies.activeId || '';
    if (!sim) return null;
    const names = await runsWithResults(d.hostCall, rt, project, sim, 'study_edit');
    if (!names.length) return null;
    return { risk: 'destructive', note: resultsNote(names), detail: names.slice(0, 6).map((n) => ({ label: 'Has results', value: n })) };
  };
  return hostTool({
    name: 'study_edit',
    title: 'Change a study',
    description:
      'Studies of the project open here: create, copy, rename, activate, reorder, set (values; keys from catalog analyses), set_time, plugin_create, plugin_rename. id "" = the study shown. Unused: "", [].',
    schema: objectSchema({
      project_id: S.id('"" = this window\'s'),
      action: S.enum(STUDY_ACTIONS),
      id: S.id('the study ("" = shown) or plugin study'),
      ids: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 80 }, description: 'reorder: the geometry\'s studies in order' },
      analysis: S.id('create: a catalog analyses key; "" = default'),
      geometry_id: S.id('"" = the shown one'),
      copy_from: S.id('copy: the study to copy'),
      copy_mode: S.enum(['', 'settings', 'clone'], 'clone: with meshes and results'),
      time_dependency: S.enum(['', 'steady', 'transient']),
      name: S.text(120),
      plugin: S.text(64, 'plugin_create: the plugin'),
      kind: S.text(80, 'plugin_create: catalog study_kinds'),
      values: S.values(40, 2000, 'value is JSON text'),
    }),
    risk: 'edit',
    projectData: true,
    priority: 86,
    contexts,
    available: offeredIn(contexts, (ctx: ToolCtx) => (ctx.projectId ? true : 'No project is open in this window.')),
    projectOf: (_input, ctx) => ctx.projectId,
    escalate: assess,
    gateText: (input, a) => ({
      title: `Allow the Assistant to change ${input.action === 'set_time' ? 'the time dependency' : 'the settings'} of this study?`,
      copy: a?.note || 'It changes the study.',
      ...(a?.detail.length ? { detail: a.detail } : {}),
    }),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const action = str(input.action);
      const tool = `study_edit.${action}`;
      const o = via(rt, tool);
      try {
        const project = await writableProject(input, rt.ctx, d.hostCall, rt);
        const studies = await studiesOf(d.hostCall, project, rt, tool);
        const named = (id: string) => studies.list.find((s) => s.id === id) ?? null;
        const target = () => {
          const id = str(input.id).trim() || rt.ctx.simulationId || studies.activeId || '';
          const s = named(id);
          if (!s) return refuse('not_found', id ? `No study ${quoted(id)} in this project.` : 'This project has no study yet.', 'project_summary lists the studies.');
          return s;
        };
        // POST /api/simulation/update also makes its study the project's active one: a change
        // to another study than the active one puts the active one back.
        const update = async (sim: string, args: Record<string, unknown>) => {
          await d.hostCall('simulation.update', { project_id: project, simulation_id: sim, ...args }, o);
          if (studies.activeId && studies.activeId !== sim) await d.hostCall('simulation.activate', { project_id: project, simulation_id: studies.activeId }, o);
        };
        const sync = (kinds: Parameters<typeof emitSync>[2]['kinds'], sim: string | null, ids: Record<string, string[]>, active?: { study?: string }) =>
          emitSync(d, rt, { project_id: project, simulation_id: sim, kinds, ids, revs: {}, ...(active ? { active } : {}), tool });
        switch (action) {
          case 'create':
          case 'copy': {
            const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
            let created: Record<string, unknown>;
            if (action === 'create') {
              const analysis = str(input.analysis).trim();
              const known = records(registry.analysis).map((a) => str(a.key));
              if (analysis && !known.includes(analysis)) {
                return fail('not_found', `No analysis "${cleanText(analysis, 80)}".`, "catalog {kind:'analyses', key:''} lists them.");
              }
              created = (await d.hostCall('simulation.create', { project_id: project, analysis_type: analysis, time_dependency: tdOf(input.time_dependency), geometry_id: str(input.geometry_id) }, o)) as Record<string, unknown>;
            } else {
              const from = str(input.copy_from).trim();
              if (!named(from)) return fail('not_found', `No study ${quoted(from)} to copy.`, 'project_summary lists the studies.');
              created = (await d.hostCall('simulation.copy', { project_id: project, copy_from: from, copy_mode: str(input.copy_mode) || 'settings', geometry_id: str(input.geometry_id) }, o)) as Record<string, unknown>;
            }
            const sim = isRecord(created.simulation) ? created.simulation : {};
            const id = str(sim.id);
            if (!id) return fail('app_error', 'The app made no study.');
            // The create route ignores `name`: the rename follows.
            const name = cleanText(str(input.name).trim(), 64);
            if (name) await d.hostCall('simulation.update', { project_id: project, simulation_id: id, name }, o);
            // Settings given with the create, checked against its analysis.
            if (Array.isArray(input.values) && input.values.length) {
              const parsed = parseValues(input.values, studyFields(registry, str(sim.analysis_type)));
              if (!parsed.ok) {
                sync(['study', 'active', 'tree'], id, { study: [id] }, { study: id });
                return badValues(parsed.problems, `The study was made (${id}); set its settings again with study_edit {action:'set'}. catalog {kind:'analyses', key} lists them.`);
              }
              await d.hostCall('simulation.update', { project_id: project, simulation_id: id, settings: nest(parsed.values) }, o);
            }
            // A new study's first run (the page's create makes none; check, then make it once).
            let run = '';
            const status = (await d.hostCall('run.status', { project_id: project, simulation_id: id }, o)) as Record<string, unknown>;
            if (!records(status.runs).length) {
              const made = (await d.hostCall('run.create', { project_id: project, simulation_id: id, name: 'Run 1' }, o)) as Record<string, unknown>;
              run = str(isRecord(made.run) ? made.run.id : '');
            }
            sync(['study', 'runs', 'active', 'tree'], id, { study: [id], ...(run ? { run: [run] } : {}) }, { study: id });
            const shown = name || str(sim.name) || 'the study';
            return okDone({
              done: `${action === 'create' ? 'Created' : 'Copied into'} study ${quoted(shown)}${run ? ' with Run 1' : ''}; it is now the active study.`,
              ids: { study: id, ...(run ? { run } : {}) },
              hint: "Next: setup_edit materials and boundary conditions; read_setup {what:'faces'} lists the faces.",
            });
          }
          case 'rename': {
            const s = target();
            const name = cleanText(str(input.name).trim(), 64);
            if (!name) return fail('invalid_input', 'rename needs a name.');
            await update(str(s.id), { name });
            sync(['study', 'tree'], str(s.id), { study: [str(s.id)] });
            return okDone({ done: `Renamed study ${quoted(s.name)} to ${quoted(name)}.`, ids: { study: str(s.id) } });
          }
          case 'activate': {
            // The route answers 200 to an unknown id: checked here first.
            const id = str(input.id).trim();
            const s = named(id);
            if (!s) return fail('not_found', `No study ${quoted(id)} in this project.`, 'project_summary lists the studies.');
            await d.hostCall('simulation.activate', { project_id: project, simulation_id: id }, o);
            sync(['active', 'tree'], id, { study: [id] }, { study: id });
            return okDone({ done: `Study ${quoted(s.name)} is now the active study.`, ids: { study: id } });
          }
          case 'reorder': {
            const ids = (Array.isArray(input.ids) ? input.ids : []).map((x) => str(x));
            const geometry = str(input.geometry_id).trim() || str(named(ids[0] ?? '')?.geometry_id);
            const mine = studies.list.filter((s) => !geometry || str(s.geometry_id) === geometry).map((s) => str(s.id));
            const same = ids.length === mine.length && new Set(ids).size === ids.length && ids.every((id) => mine.includes(id));
            if (!same) {
              return fail('invalid_input', 'reorder needs every study of the geometry exactly once.', 'project_summary lists the studies with their geometry_id.', { studies_of_geometry: mine });
            }
            await d.hostCall('simulation.reorder', { project_id: project, ids, geometry_id: geometry }, o);
            sync(['study', 'tree'], null, { study: ids });
            return okDone({ done: `Reordered ${ids.length} studies.`, ids: {} });
          }
          case 'set': {
            const s = target();
            const registry = (await d.hostCall('registry.get', {}, o)) as Record<string, unknown>;
            const parsed = parseValues(input.values, studyFields(registry, str(s.analysis_type)));
            if (!parsed.ok) return badValues(parsed.problems, `catalog {kind:'analyses', key:'${cleanText(str(s.analysis_type), 80)}'} lists the fields.`);
            if (!Object.keys(parsed.values).length) return fail('invalid_input', 'set needs at least one value.');
            try {
              await update(str(s.id), { settings: nest(parsed.values) });
            } catch (err) {
              // The route's own refusal names its key.
              if (err instanceof HostCallError && err.status === 400 && err.detail && typeof err.detail.key === 'string') {
                return badValues([{ key: err.detail.key, problem: err.message }], 'catalog lists the fields.');
              }
              throw err;
            }
            sync(['study'], str(s.id), { study: [str(s.id)] });
            const keys = Object.keys(parsed.values);
            return okDone({ done: `Set ${keys.join(', ')} of study ${quoted(s.name)}.`, ids: { study: str(s.id) } });
          }
          case 'set_time': {
            const s = target();
            const td = tdOf(input.time_dependency);
            if (!td) return fail('invalid_input', 'set_time needs time_dependency "steady" or "transient".');
            // The route re-saves the study's draft runs with it (they follow the study).
            await update(str(s.id), { time_dependency: td });
            sync(['study', 'runs'], str(s.id), { study: [str(s.id)] });
            return okDone({ done: `Study ${quoted(s.name)} is now ${td}; its draft runs follow.`, ids: { study: str(s.id) } });
          }
          case 'plugin_create': {
            const plugin = str(input.plugin).trim();
            const kind = str(input.kind).trim();
            if (!plugin || !kind) return fail('invalid_input', 'plugin_create needs plugin and kind.', "catalog {kind:'study_kinds'} lists them.");
            const made = (await d.hostCall('plugin_studies.create', { project_id: project, plugin, kind, title: cleanText(str(input.name).trim(), 120) }, o)) as Record<string, unknown>;
            const study = isRecord(made.study) ? made.study : {};
            const id = str(study.id);
            sync(['plugin_studies', 'tree'], null, { plugin_study: [id] });
            return okDone({
              done: `Created ${quoted(study.title)} (${cleanText(str(study.plugin_name) || plugin, 60)}).`,
              ids: { plugin_study: id, workspace: str(study.workspace) },
              hint: `Open it with core__show {target:'workspace', id:'${id}'}.`,
            });
          }
          case 'plugin_rename': {
            const id = str(input.id).trim();
            const name = cleanText(str(input.name).trim(), 120);
            if (!name) return fail('invalid_input', 'plugin_rename needs a name.');
            const list = records(((await d.hostCall('plugin_studies.list', { project_id: project }, o)) as Record<string, unknown>).studies);
            const s = list.find((x) => x.id === id);
            if (!s) return fail('not_found', `No plugin study ${quoted(id)}.`, 'project_summary lists them.');
            // A rev other than the study's is the worker's -32009: host-call answers it stale_record.
            await d.hostCall('plugin_studies.rename', { project_id: project, plugin: str(s.plugin), study_id: id, title: name, rev: Number(s.rev) || 0 }, o);
            sync(['plugin_studies', 'tree'], null, { plugin_study: [id] });
            return okDone({ done: `Renamed ${quoted(s.title)} to ${quoted(name)}.`, ids: { plugin_study: id } });
          }
          default:
            return fail('invalid_input', `Unknown action "${cleanText(action, 40)}".`);
        }
      } catch (err) {
        return failed(err, 'project_summary lists the studies.');
      }
    },
  });
}
