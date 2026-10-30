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
 *   chat_history     this project's saved Assistant chats (the dock's History), and Clear history
 *
 * Reads take a project_id (the turn's by default); writes go only to the project open in
 * the turn's window. chat_history reads the Assistant's own files (history.ts), not the app's
 * routes, and only the turn's own project's (or Home's). connection_check {word} exists for Settings' Test only; it is never
 * offered to a turn.
 */
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadedPlugins } from '../../registry-defaults.js';
import { CONNECTION_CHECK } from './provider-test.ts';
import { createJobTools } from './host/job-tools.ts';
import { agentPrefs, loadSettings } from './settings.ts';
import { agentIdOf } from './agents/known.ts';
import { spendLedger } from './ledger.ts';
import { attachments } from './attachments.ts';
import { HOST_STALL_MS, type ToolDef, type ToolOutcome, type ToolRunContext } from './registry.ts';
import type { JsonSchemaObject, ProviderId } from './types.ts';
import { appStatusTool } from './host/app-status.ts';
import { catalogTool } from './host/catalog.ts';
import { hostTool, NO_PROJECT, paced, type HostToolDeps } from './host/common.ts';
import { createHostTransport } from './host-call.ts';
import { uiSync, uiSyncOrigin, type UiSyncInput } from '../ui-sync.ts';
import { chatHistoryTool } from './host/chat-history.ts';
import { deleteTool } from './host/delete.ts';
import { explainReadyTool } from './host/explain-ready.ts';
import { importFileTool } from './host/import-file.ts';
import { projectEditTool } from './host/project-edit.ts';
import { projectSummaryTool } from './host/project-summary.ts';
import { projectsTool } from './host/projects.ts';
import { readResultsTool } from './host/read-results.ts';
import { readSetupTool } from './host/read-setup.ts';
import { setupEditTool } from './host/setup-edit.ts';
import { studyEditTool } from './host/study-edit.ts';

export type { HostToolDeps } from './host/common.ts';

export function createHostTools(deps: HostToolDeps): ToolDef[] {
  // A tool's own steps wait for the turn's call rate rather than fail half done.
  const d: HostToolDeps = { ...deps, hostCall: paced(deps.hostCall) };
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
    // "Never send project data" keeps a saved chat's words from going somewhere they never went.
    chatHistoryTool({ history: d.history, ...(d.assistantSettings ? { settings: d.assistantSettings } : {}) }),
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

/**
 * A test-only tool (MAGNUSIM_TEST_ASSISTANT=1 and MAGNUSIM_TEST_UI_SYNC=1, both): it says the
 * turn's project changed, as a writing tool does after its route answered (ui-sync.ts), so the
 * browser tests can show the dock's "Updated" line before the real writing tools exist. It
 * writes nothing itself.
 */
export function testUiSyncTool(): ToolDef {
  return {
    ...hostTool({
      name: 'test_ui_sync',
      title: 'Say what changed (test)',
      description: 'Test only: tells the open window that a record of the project changed.',
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', maxLength: 40 },
          record: { type: 'string', maxLength: 40 },
          id: { type: 'string', maxLength: 120 },
          name: { type: 'string', maxLength: 120 },
        },
        required: ['kind', 'record', 'id', 'name'],
        additionalProperties: false,
      } as JsonSchemaObject,
      risk: 'edit',
      projectData: false,
      contexts: ['home', 'workbench', 'workspace'],
      available: (ctx) => (ctx.projectId ? true : NO_PROJECT),
      async run(input: Record<string, unknown>, rt: ToolRunContext): Promise<ToolOutcome> {
        const id = String(input.id || '');
        const sent = uiSync.emit({
          project_id: String(rt.ctx.projectId || ''),
          simulation_id: rt.ctx.simulationId,
          kinds: [String(input.kind || '')] as UiSyncInput['kinds'],
          ids: { [String(input.record || '')]: [id] },
          revs: {},
          names: { [id]: String(input.name || '') },
          ...uiSyncOrigin(rt),
          tool: 'test_ui_sync',
        });
        return sent ? { ok: true, data: { done: 'said' }, summary: 'Said what changed' } : { ok: false, error: { code: 'bad_values', message: 'Nothing to say.' }, summary: 'Nothing said' };
      },
    }),
    risk: 'edit',
  };
}

/** The host tools as the server uses them: the app over loopback on `port`, the settings, package.json and the live registry. */
export function defaultHostTools(port: () => number | null | undefined, more: Partial<HostToolDeps> = {}): ToolDef[] {
  const transport = createHostTransport({ port });
  const test = process.env.MAGNUSIM_TEST_ASSISTANT === '1' && process.env.MAGNUSIM_TEST_UI_SYNC === '1' ? [testUiSyncTool()] : [];
  const tools = createHostTools({
    hostCall: transport.call,
    assistant: async () => {
      const s = await loadSettings();
      // The default's (a turn passes its own through ToolCtx.assistant): a coding agent's model is its saved choice.
      const agent = agentIdOf(s.provider);
      return { provider: s.provider, model: s.provider === 'off' ? '' : agent ? (agentPrefs(s, agent).model ?? '') : s.models[s.provider as ProviderId] };
    },
    assistantSettings: async () => {
      const s = await loadSettings();
      return { effort: s.effort, privacy: s.privacy, caps: { ...s.caps } as unknown as Record<string, number>, provider_log: s.provider_log };
    },
    spentToday: async () => (await spendLedger()).spentToday(),
    version: appVersion,
    plugins: () => loadedPlugins(),
    attachments,
    uiSync,
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
  // The job tools (compute, wait, jobs; spec 06 C4).
  return [...tools, ...createJobTools({ call: transport.call }), ...test];
}
