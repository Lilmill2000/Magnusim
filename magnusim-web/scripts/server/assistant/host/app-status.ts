/**
 * app_status (Core host tools spec 4.1): the app, the Assistant's own settings (read only:
 * nothing writes them), the plugins with their environments, the units preference, this
 * PC's hardware summary and the compute queue. Not project data: another project's queue
 * rows carry only their kind and place, never a name, an id or the project.
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { failed, hostTool, isRecord, num, objectSchema, offeredIn, okData, placeOf, records, str, text, usedOf, via, type HostToolDeps, type HostToolDef } from './common.ts';

export function appStatusTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench', 'workspace'] as const;
  return hostTool({
    name: 'app_status',
    title: 'Read the app status',
    description:
      "Magnusim's version, the Assistant's provider, model, caps and today's spend (you can't change these), the plugins and their environments, the units preference, this PC's hardware and the compute queue. Reads no project.",
    schema: objectSchema({}),
    risk: 'read',
    projectData: false,
    priority: 50,
    contexts,
    available: offeredIn(contexts),
    async run(_input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      try {
        const own = rt.ctx.assistant;
        const [version, assistant, queue, prefs, pluginsList, settings, spent] = await Promise.all([
          d.version(),
          own ? Promise.resolve(own) : d.assistant(),
          d.call('queue.get', {}, via(rt, 'app_status')) as Promise<Record<string, unknown>>,
          (d.call('prefs.get', {}, via(rt, 'app_status')) as Promise<Record<string, unknown>>).catch(() => ({}) as Record<string, unknown>),
          (d.call('plugins.list', {}, via(rt, 'app_status')) as Promise<Record<string, unknown>>).catch(() => null),
          d.assistantSettings ? d.assistantSettings().catch(() => null) : Promise.resolve(null),
          d.spentToday ? d.spentToday().catch(() => null) : Promise.resolve(null),
        ]);
        // The plugins as the app lists them (on/off, environment), else the loaded registry's.
        const rows = pluginsList ? records(pluginsList.plugins) : d.plugins().filter(isRecord);
        const plugins = rows.slice(0, 60).map((p) => {
          const env = isRecord(p.python_env) ? p.python_env : null;
          const state = env ? str(env.state) : '';
          return {
            key: text(p.key, 64),
            name: text(p.name),
            version: text(p.version, 40),
            on: p.enabled === undefined ? true : p.enabled === true,
            env: !env ? 'none' : state === 'ready' ? 'ready' : state === 'failed' ? 'failed' : state === 'installing' ? 'installing' : 'missing',
          };
        });
        // "Mine" is the turn's project; another project's rows say only what kind waits where.
        const mine = rt.ctx.projectId;
        const busy = isRecord(queue.busy) ? queue.busy : null;
        const live = busy
          ? busy.project_id && busy.project_id === mine
            ? { kind: text(busy.kind, 20), mine: true, name: text(busy.mesh_name ?? busy.name) }
            : { kind: text(busy.kind, 20), mine: false }
          : null;
        const items = records(queue.items).slice(0, 50).map((row, i) => {
          const position = num(row.position) ?? i + 1;
          return row.project_id && row.project_id === mine
            ? { id: text(row.id, 80), kind: text(row.kind, 20), mine: true, name: text(row.name), position }
            : { kind: text(row.kind, 20), mine: false, position };
        });
        const hw = isRecord(prefs.hardware) ? prefs.hardware : null;
        const used = usedOf(rt.ctx);
        const data = {
          app: { version: text(version, 40) },
          assistant: {
            provider: text(assistant.provider, 40),
            model: text(assistant.model, 128),
            ...(settings ? { effort: text(settings.effort, 20), privacy: text(settings.privacy, 20), caps: settings.caps } : {}),
            ...(spent !== null ? { spent_today_usd: Math.round(spent * 100) / 100 } : {}),
            ...(used ? { this_turn: used } : {}),
            can_change_these: false,
          },
          plugins,
          units: prefs.units === 'Imperial' ? 'Imperial' : 'Metric',
          hardware: hw
            ? {
                cores: num(hw.physical_cores) ?? num(hw.logical_cpus),
                ram_gb: num(hw.ram_gb),
                openfoam: hw.openfoam_ok === true ? 'ok' : hw.openfoam_ok === false ? 'missing' : 'unknown',
                checked_at: text(hw.checked_at, 40),
              }
            : { cores: null, ram_gb: null, openfoam: 'unknown', checked_at: null },
          compute: { busy: !!busy, live, queue: items },
          where: placeOf(rt.ctx),
        };
        return okData(data, `Magnusim ${data.app.version}, ${plugins.length} plugins, compute ${busy ? 'busy' : 'idle'}, ${items.length} queued`);
      } catch (err) {
        return failed(err);
      }
    },
  });
}
