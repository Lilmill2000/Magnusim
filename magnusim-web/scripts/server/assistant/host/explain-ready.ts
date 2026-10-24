/**
 * explain_ready (Core host tools spec 4.6): what still blocks a study's run, as the Start
 * button sees it, each issue's fix also named as the tool call that makes it (the page's
 * openSetupFix targets). Every field required, so the schema is strict-friendly.
 */
import type { ToolOutcome, ToolRunContext } from '../registry.ts';
import { cleanText } from '../sanitize.ts';
import { failed, hostTool, isRecord, objectSchema, offeredIn, okData, projectIdOf, readableProject, records, S, str, studyIdOf, text, via, type HostToolDeps, type HostToolDef } from './common.ts';

/** The tool call that fixes an issue, by its fix's `go` (runtime.js openSetupFix). */
export function fixCall(go: string, fix: Record<string, unknown>): string | null {
  switch (go) {
    case 'plugins':
      return "app_status (a plugin is off or missing: ask the person to turn it on in Settings)";
    case 'create-sim':
      return "study_edit {action:'create'}";
    case 'study':
    case 'sim-hub':
      return "study_edit {action:'set'} (catalog {kind:'analyses', key} lists the settings)";
    case 'add-run':
      return "setup_edit {kind:'run', action:'add'}";
    case 'mat-picker':
    case 'material':
    case 'materials':
      return "setup_edit {kind:'material', action:'add'} or {action:'assign'}";
    case 'bc-picker':
    case 'bcs':
      return "setup_edit {kind:'bc', action:'add'}";
    case 'bc':
      return `setup_edit {kind:'bc', action:'update'${fix.id ? `, id:'${cleanText(str(fix.id), 80)}'` : ''}}`;
    case 'mesh-hub':
      return "setup_edit {kind:'mesh', action:'add'}";
    case 'run-mesh':
      return "setup_edit {kind:'run', action:'update'} with values mesh_id";
    case 'mesh':
      return `compute {action:'mesh_generate'${fix.id ? `, mesh_id:'${cleanText(str(fix.id), 80)}'` : ''}}`;
    default:
      return null;
  }
}

export function explainReadyTool(d: HostToolDeps): HostToolDef {
  const contexts = ['home', 'workbench', 'workspace'] as const;
  return hostTool({
    name: 'explain_ready',
    title: 'Explain why a run can or can’t start',
    description:
      "What still blocks a study's run, as the Start button sees it: each issue with what to fix and the tool call that fixes it. \"\" = this window's project, the shown study, the study's active run.",
    schema: objectSchema({
      project_id: S.id('"" = this window\'s project'),
      simulation_id: S.id('"" = the study shown'),
      run_id: S.id('"" = the study\'s active run'),
    }),
    risk: 'read',
    projectData: true,
    priority: 78,
    workerBacked: true,
    contexts,
    available: offeredIn(contexts),
    projectOf: (input, ctx) => projectIdOf(input, ctx),
    async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
      try {
        const project = await readableProject(input, rt.ctx, d);
        const { id: sim } = await studyIdOf(input, rt.ctx, project, d.hostCall, rt, 'explain_ready');
        const verdict = (await d.hostCall('run.ready', { project_id: project, simulation_id: sim, run_id: str(input.run_id) }, via(rt, 'explain_ready'))) as Record<string, unknown>;
        const issues = records(verdict.issues)
          .slice(0, 50)
          .map((i) => {
            const fix = typeof i.fix === 'string' ? cleanText(i.fix, 300) : isRecord(i.fix) ? { go: text(i.fix.go, 40), name: text(i.fix.name) } : null;
            const call = isRecord(i.fix) ? fixCall(str(i.fix.go), i.fix) : null;
            return { message: cleanText(i.message, 500), ...(fix ? { fix } : {}), ...(call ? { fix_with: call } : {}) };
          });
        // A stale mesh is put first without `ready` changing (w27): the issues decide.
        const ready = issues.length === 0 && verdict.ready !== false;
        return okData({ ready, simulation_id: sim, issues }, ready ? 'Ready to run' : `${issues.length} issue${issues.length === 1 ? ' blocks' : 's block'} the run`);
      } catch (err) {
        return failed(err);
      }
    },
  });
}
