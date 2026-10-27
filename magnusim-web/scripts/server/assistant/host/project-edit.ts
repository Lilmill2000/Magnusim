/**
 * project_edit (Core host tools spec 4.8): what a person does to a project's card and on
 * Home: create a project (or one from a sample, or one a plugin's start button makes),
 * change its title, description, category or folder, move it, and make a folder. The card
 * actions take a project_id from anywhere (Daniel, Q1); a units change converts the values
 * the person entered, so it asks first, naming what converts, and needs the project open in
 * this window (the open page converts them when it hears the change).
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { bcFamily } from './catalog.ts';
import {
  emitSync,
  fail,
  failed,
  hostTool,
  isRecord,
  objectSchema,
  offeredIn,
  okDone,
  projectIdOf,
  quoted,
  records,
  S,
  str,
  via,
  type AssessContext,
  type Assessed,
  type HostToolDeps,
  type HostToolDef,
} from './common.ts';

export const PROJECT_ACTIONS = ['create', 'update', 'move', 'new_folder', 'from_sample', 'start_action'] as const;
const ROOT_FOLDER = 'My Projects';
const OPEN_HINT = "Open it with core__show {target:'project', project_id} (or {target:'workspace'}) before changing it.";

/** How many BCs and refinements of a project hold values with units (what a units change converts). */
export async function unitBearing(d: HostToolDeps, rt: { signal: AbortSignal; turn: string | null }, project: string): Promise<{ bcs: number; refinements: number }> {
  const o = via(rt, 'project_edit.units');
  const [bcs, registry, sims] = await Promise.all([
    d.hostCall('bcs.get', { project_id: project }, o) as Promise<Record<string, unknown>>,
    d.hostCall('registry.get', {}, o) as Promise<Record<string, unknown>>,
    d.hostCall('simulation.get', { project_id: project }, o) as Promise<Record<string, unknown>>,
  ]);
  // A BC converts when its family names a unit field and the record holds a number for it.
  const nBcs = records(bcs.boundary_conditions_all).filter((b) => {
    const family = bcFamily(registry, str(b.bc_type));
    return records(family?.values).some((row) => typeof b[str(row.field)] === 'number' && !!row.unit_field);
  }).length;
  let nRefs = 0;
  for (const s of records(sims.simulations).slice(0, 50)) {
    const refs = (await d.hostCall('refinements.get', { project_id: project, simulation_id: str(s.id) }, o)) as Record<string, unknown>;
    nRefs += records(refs.refinements).length;
  }
  return { bcs: nBcs, refinements: nRefs };
}

export function projectEditTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench'] as const;
  const rowOf = async (rt: { signal: AbortSignal; turn: string | null }, id: string) =>
    records(((await d.hostCall('projects.list', {}, via(rt, 'project_edit'))) as Record<string, unknown>).projects).find((p) => p.id === id) ?? null;

  const assess = async (input: Record<string, unknown>, a: AssessContext): Promise<Assessed | null> => {
    const units = str(input.units);
    if (input.action !== 'update' || !units) return null;
    const id = projectIdOf(input, a.ctx);
    if (!id) return null;
    const rt = { signal: a.signal, turn: a.turn };
    const row = await rowOf(rt, id);
    if (!row || (str(row.units) || 'Metric') === units) return null;
    const n = await unitBearing(d, rt, id);
    const parts = [n.bcs ? `${n.bcs} boundary condition${n.bcs === 1 ? '' : 's'}` : '', n.refinements ? `${n.refinements} mesh refinement${n.refinements === 1 ? '' : 's'}` : ''].filter(Boolean);
    const from = str(row.units) || 'Metric';
    return {
      risk: 'destructive',
      note: `${parts.length ? `Converts the values you entered in ${parts.join(' and ')}` : 'Converts the values you entered'} from ${from === 'Imperial' ? 'US' : 'Metric'} to ${units === 'Imperial' ? 'US' : 'Metric'} units. Results already computed are not converted.`,
      detail: [
        { label: 'Project', value: cleanText(str(row.title), 80) },
        { label: 'Units', value: `${from} → ${units}` },
      ],
    };
  };

  return hostTool({
    name: 'project_edit',
    title: 'Change or create a project',
    description:
      'create, update (title, description, category, units, folder), move, new_folder, from_sample, start_action (a new project with a plugin study; to add one to an existing project use study_edit plugin_create). project_id "" = this window\'s. A units change needs the project open here. Unused fields: "".',
    schema: objectSchema({
      action: S.enum(PROJECT_ACTIONS),
      project_id: S.id('update/move: the project; "" = this window\'s'),
      title: S.text(120),
      description: S.text(2000),
      // New project's Category list: a person cannot type their own (two-way parity).
      category: S.enum(['', 'Other', 'Fluid dynamics', 'Solid mechanics']),
      units: S.enum(['', 'Metric', 'Imperial']),
      folder: S.text(120, '"" = My Projects / unchanged'),
      plugin: S.text(64, 'from_sample, start_action'),
      key: S.text(120, 'from_sample: the sample; start_action: the study kind'),
    }),
    risk: 'edit',
    projectData: false,
    priority: 54,
    contexts,
    available: offeredIn(contexts),
    projectOf: (input, ctx) => (input.action === 'update' || input.action === 'move' ? projectIdOf(input, ctx) : null),
    escalate: assess,
    gateText: (_input, a) => ({ title: 'Allow the Assistant to change the units of this project?', copy: a?.note || 'It changes the project.', ...(a?.detail.length ? { detail: a.detail } : {}) }),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      const action = str(input.action);
      const o = via(rt, `project_edit.${action}`);
      const folder = cleanText(str(input.folder).trim(), 120);
      const title = cleanText(str(input.title).trim(), 120);
      try {
        const sync = (project: string, kinds: Parameters<typeof emitSync>[2]['kinds']) => emitSync(d, rt, { project_id: project, simulation_id: null, kinds, ids: { project: [project] }, revs: {}, tool: `project_edit.${action}` });
        const ensureFolder = async () => {
          if (!folder || folder === ROOT_FOLDER) return;
          const list = (await d.hostCall('projects.list', {}, o)) as Record<string, unknown>;
          if (!(Array.isArray(list.folders) ? list.folders : []).includes(folder)) await d.hostCall('folders.create', { name: folder }, o);
        };
        switch (action) {
          case 'create': {
            if (!title) return fail('invalid_input', 'create needs a title.');
            await ensureFolder();
            const made = (await d.hostCall('project.create', { title, description: str(input.description), category: str(input.category), units: str(input.units), folder }, o)) as Record<string, unknown>;
            const id = str(made.id);
            return okDone({ done: `Created project ${quoted(made.title ?? title)}${folder ? ` in ${quoted(folder)}` : ''}.`, ids: { project: id }, hint: OPEN_HINT });
          }
          case 'new_folder': {
            if (!folder || folder === ROOT_FOLDER) return fail('invalid_input', 'new_folder needs a folder name other than My Projects.');
            await d.hostCall('folders.create', { name: folder }, o);
            return okDone({ done: `Made folder ${quoted(folder)}.`, ids: {} });
          }
          case 'from_sample': {
            const plugin = str(input.plugin).trim();
            const sample = str(input.key).trim();
            if (!plugin || !sample) return fail('invalid_input', 'from_sample needs plugin and key (the sample).', "catalog {kind:'samples', key:''} lists them.");
            rt.progress(null, 'Copying the sample');
            const made = (await d.hostCall('project.sample', { plugin, sample, folder }, o)) as Record<string, unknown>;
            return okDone({ done: `Created project ${quoted(made.title)} from the sample.`, ids: { project: str(made.id) }, hint: OPEN_HINT });
          }
          case 'start_action': {
            const plugin = str(input.plugin).trim();
            const kind = str(input.key).trim();
            // start_action always makes a new project. Seen live: given a project_id, it made a
            // stray "Part project" beside the one the model meant.
            if (str(input.project_id).trim()) {
              return fail(
                'invalid_input',
                'start_action makes a new project; it does not add to an existing one.',
                `To add a study to that project: study_edit {action:'plugin_create', plugin:'${cleanText(plugin, 64)}', kind:'${cleanText(kind, 80)}'} with the project open.`,
              );
            }
            const plugins = records(((await d.hostCall('plugins.list', {}, o)) as Record<string, unknown>).plugins);
            const p = plugins.find((x) => x.key === plugin && x.enabled !== false);
            const act = p ? records(p.start_actions).find((a) => a.study_kind === kind) : null;
            if (!act) return fail('not_found', `No start action "${cleanText(kind, 80)}" of plugin "${cleanText(plugin, 64)}".`, "catalog {kind:'start_actions', key:''} lists them.");
            const kindTitle = cleanText(str(act.kind_title) || kind, 80);
            await ensureFolder();
            const made = (await d.hostCall('project.create', { title: title || `${kindTitle} project`, description: str(input.description), category: str(input.category), units: str(input.units), folder }, o)) as Record<string, unknown>;
            const id = str(made.id);
            // As the workspace's own start does (startActions.ts startStudy): "<kind title> 1".
            const study = (await d.hostCall('plugin_studies.create', { project_id: id, plugin, kind, title: `${kindTitle} 1` }, o)) as Record<string, unknown>;
            const s = isRecord(study.study) ? study.study : {};
            return okDone({
              done: `Created project ${quoted(made.title ?? title)} with ${quoted(s.title)}.`,
              ids: { project: id, study: str(s.id), workspace: str(s.workspace) },
              hint: `Open it with core__show {target:'workspace', project_id:'${id}', id:'${str(s.id)}'}.`,
            });
          }
          case 'update':
          case 'move': {
            const id = projectIdOf(input, rt.ctx);
            if (!id) return fail('no_project', 'Name the project: project_id from projects.', 'projects lists them.');
            const row = await rowOf(rt, id);
            if (!row) return fail('not_found', `No project "${cleanText(id, 80)}".`, 'projects lists them.');
            if (action === 'move') {
              await d.hostCall('project.move', { project_id: id, folder: folder || ROOT_FOLDER }, o);
              sync(id, ['project']);
              return okDone({ done: `Moved project ${quoted(row.title)} to ${quoted(folder || ROOT_FOLDER)}.`, ids: { project: id } });
            }
            const units = str(input.units);
            const unitsChange = !!units && units !== (str(row.units) || 'Metric');
            // A units change converts the entered values in the open page: only in this window's project.
            if (unitsChange && id !== rt.ctx.projectId) {
              return fail('not_this_project', 'A units change converts the values entered in the project, so it needs the project open in this window.', `Open it first: core__show {target:'project', project_id:'${cleanText(id, 80)}'}, then call this again.`);
            }
            const description = str(input.description);
            const category = cleanText(str(input.category).trim(), 80);
            if (!title && !description && !category && !units && !folder) return fail('invalid_input', 'update needs at least one of title, description, category, units, folder.');
            await d.hostCall('project.update', { project_id: id, title, description, category, units: unitsChange ? units : '', folder }, o);
            sync(id, ['project', 'tree']);
            const what = [title && 'title', description && 'description', category && 'category', unitsChange && 'units', folder && 'folder'].filter(Boolean).join(', ');
            return okDone({ done: `Changed the ${what} of project ${quoted(title || row.title)}.${unitsChange ? ' The open window converts the entered values.' : ''}`, ids: { project: id } });
          }
          default:
            return fail('invalid_input', `Unknown action "${cleanText(action, 40)}".`);
        }
      } catch (err) {
        return failed(err, 'projects lists the projects.');
      }
    },
  });
}
