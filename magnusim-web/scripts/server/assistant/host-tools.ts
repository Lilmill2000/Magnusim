/**
 * The host's own tools (Foundation spec 7.4; Core host tools spec 4): all through the app's
 * own routes over loopback (host/route-call.ts, the entries of host-routes.ts), each answer
 * built from a whitelist of fields (never a path, the projects folder or a thumbnail
 * address). One file per tool under host/:
 *
 *   app_status       the app, the Assistant's own settings (read only), plugins, queue
 *   catalog          what the app offers, and each item's fields
 *   projects         the project list, as Home filters it
 *   project_summary  a project's card and contents (with its picture)
 *   read_setup       one part of a study's setup, faces and bodies
 *   explain_ready    what blocks a run, and the call that fixes it
 *   read_results     a run's numbers
 *   project_edit     create, change, move a project; folders; samples; start actions
 *   study_edit       a study's create, copy, rename, activate, reorder and settings
 *   setup_edit       materials, BCs, meshes, refinements, runs, monitors, geometry
 *   import_file      a dock attachment or a typed path as a new geometry
 *   delete           anything the person can delete, with its knock-on effects named
 *
 * Reads take a project_id (the turn's by default); writes go only to the project open in
 * the turn's window. connection_check {word} exists for Settings' Test only; it is never
 * offered to a turn.
 */
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadedPlugins } from '../../registry-defaults.js';
import { CONNECTION_CHECK } from './provider-test.ts';
import { agentPrefs, loadSettings } from './settings.ts';
import { agentIdOf } from './agents/known.ts';
import { spendLedger } from './ledger.ts';
import { attachments } from './attachments.ts';
import { HOST_STALL_MS, type ToolDef, type ToolOutcome } from './registry.ts';
import type { ProviderId } from './types.ts';
import { appStatusTool } from './host/app-status.ts';
import { catalogTool } from './host/catalog.ts';
import type { HostToolDeps } from './host/common.ts';
import { deleteTool } from './host/delete.ts';
import { explainReadyTool } from './host/explain-ready.ts';
import { importFileTool } from './host/import-file.ts';
import { projectEditTool } from './host/project-edit.ts';
import { projectSummaryTool } from './host/project-summary.ts';
import { projectsTool } from './host/projects.ts';
import { readResultsTool } from './host/read-results.ts';
import { readSetupTool } from './host/read-setup.ts';
import { createRouteCaller } from './host/route-call.ts';
import { setupEditTool } from './host/setup-edit.ts';
import { studyEditTool } from './host/study-edit.ts';

export type { HostToolDeps } from './host/common.ts';

export function createHostTools(d: HostToolDeps): ToolDef[] {
  return [
    appStatusTool(d),
    catalogTool(d),
    projectsTool(d),
    projectSummaryTool(d),
    readSetupTool(d),
    explainReadyTool(d),
    readResultsTool(d),
    projectEditTool(d),
    studyEditTool(d),
    setupEditTool(d),
    importFileTool(d),
    deleteTool(d),
  ];
}

/** Settings' Test tool: never in any turn's offered list. */
export function connectionCheckTool(): ToolDef {
  return {
    name: CONNECTION_CHECK.name,
    localName: CONNECTION_CHECK.name,
    title: 'Check the connection',
    description: CONNECTION_CHECK.description,
    schema: CONNECTION_CHECK.schema,
    risk: 'read',
    source: { kind: 'host' },
    stallMs: HOST_STALL_MS,
    workerBacked: false,
    projectData: false,
    available: () => true,
    async run(input: Record<string, unknown>): Promise<ToolOutcome> {
      return { ok: true, data: { word: input.word === 'ok' ? 'ok' : null }, summary: 'Connection checked' };
    },
  };
}

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
let versionRead: Promise<string> | null = null;

/** The app's version from package.json, read once. */
export function appVersion(): Promise<string> {
  versionRead ??= readFile(PACKAGE_JSON, 'utf8')
    .then((t) => String((JSON.parse(t) as { version?: unknown }).version ?? ''))
    .catch(() => '');
  return versionRead;
}

/** The host tools as the server uses them: the app over loopback on `port`, the settings, package.json and the live registry. */
export function defaultHostTools(port: () => number | null | undefined, more: Partial<HostToolDeps> = {}): ToolDef[] {
  return createHostTools({
    call: createRouteCaller({ port }),
    assistant: async () => {
      const s = await loadSettings();
      // The default's (a turn passes its own through ToolCtx.assistant): a coding agent's model is its saved choice.
      const agent = agentIdOf(s.provider);
      return { provider: s.provider, model: s.provider === 'off' ? '' : agent ? (agentPrefs(s, agent).model ?? '') : s.models[s.provider as ProviderId] };
    },
    assistantSettings: async () => {
      const s = await loadSettings();
      return { effort: s.effort, privacy: s.privacy, caps: { ...s.caps } as unknown as Record<string, number> };
    },
    spentToday: async () => (await spendLedger()).spentToday(),
    version: appVersion,
    plugins: () => loadedPlugins(),
    attachments,
    statFile: async (path: string) => {
      try {
        const st = await stat(path);
        return { size: st.size, file: st.isFile() };
      } catch {
        return null;
      }
    },
    ...more,
  });
}
