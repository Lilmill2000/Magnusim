/**
 * The core page's tool definitions (core host tools spec 5.1, 5.2): what every app tab registers
 * in its `core` slot. Pure data, with no import the page needs at run time, so the server's
 * tests (the CAD Part's final tool list, the budgets) read the very definitions the page sends.
 */
import type { RelayTool } from './wire';

export const CORE_GUIDE = 'Use core__show to move between Home, a project and its workspaces; your tools change with the place.';

export const SHOW_TARGETS = ['home', 'project', 'geometry', 'study', 'mesh', 'run', 'results', 'panel', 'workspace'] as const;
export const SHOW_PANELS = ['', 'materials', 'bcs', 'bc_defaults', 'mesh_hub', 'refinements', 'runs', 'study', 'add_run', 'create_study', 'queue'] as const;
export const VIEW_ACTIONS = ['picture', 'fit', 'normal_to', 'orbit', 'hide', 'show', 'show_all', 'edges', 'legend'] as const;

/** core__show's input (§5.1): every property required, "" where unused. */
export const CORE_SHOW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['target', 'project_id', 'id', 'panel'],
  properties: {
    target: { type: 'string', enum: [...SHOW_TARGETS] },
    project_id: { type: 'string', maxLength: 80, description: 'project: the one to open; "" = this window\'s' },
    id: { type: 'string', maxLength: 120, description: 'the geometry, study, mesh, run, or plugin study; "" when the target needs none' },
    panel: { type: 'string', enum: [...SHOW_PANELS] },
  },
});

/** core__view's input (§5.2): every property required, sentinels where unused. */
export const CORE_VIEW_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'target_ids', 'aspect', 'size', 'with_legend', 'on', 'save'],
  properties: {
    action: { type: 'string', enum: [...VIEW_ACTIONS] },
    target_ids: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 40 }, description: 'face ids or body names (hide/show/normal_to/orbit); [] otherwise' },
    aspect: { type: 'string', enum: ['view', '16:9', '4:3', '1:1'] },
    size: { type: 'string', enum: ['small', 'medium', 'large'], description: 'picture: 640, 1024, 1600 px wide' },
    with_legend: { type: 'boolean' },
    on: { type: 'boolean', description: 'edges/legend: show or hide' },
    save: { type: 'boolean', description: "picture: also save it to the run's or mesh's Screenshots" },
  },
});

/** core__keybinds' input: every property required, "" for all. */
export const CORE_KEYBINDS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['plugin', 'target'],
  properties: {
    plugin: { type: 'string', maxLength: 80, description: 'a plugin key or name; "" = the app and every plugin' },
    target: { type: 'string', maxLength: 120, description: 'a command id (sketch.rectangle) or label; "" = every command' },
  },
});

export const KEYBIND_ACTIONS = ['set', 'reset', 'clear', 'reset_all'] as const;

/** core__set_keybind's input: every property required, sentinels where unused. */
export const CORE_SET_KEYBIND_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['plugin', 'command', 'action', 'keys', 'replace', 'person_asked'],
  properties: {
    plugin: { type: 'string', maxLength: 80, description: 'the plugin key or name (core__keybinds lists them); "app" for the Assistant panel\'s own key' },
    command: { type: 'string', maxLength: 120, description: 'the command id or label; "" for reset_all' },
    action: { type: 'string', enum: [...KEYBIND_ACTIONS] },
    keys: { type: 'string', maxLength: 40, description: 'set: the key as written ("Shift+R", "Ctrl+Alt+K", "F7"); "" otherwise' },
    replace: { type: 'boolean', description: 'take the key from the commands that have it (only once the person agreed)' },
    person_asked: { type: 'boolean', description: 'true only when the person explicitly asked for this change in this request' },
  },
});

export const CORE_TOOLS: readonly RelayTool[] = Object.freeze([
  {
    name: 'show',
    title: 'Show a place in Magnusim',
    description:
      'Moves this window as the person\'s clicks do: home, a project (Back from its workspace sends the design to the simulation), a geometry, study, mesh, run, a run\'s results, a setup panel, or a plugin study\'s workspace. project_id "" = this window\'s; id "" when unused; panel "" unless target is panel. Your tools change with the place from the next step.',
    inputSchema: CORE_SHOW_SCHEMA as unknown as Record<string, unknown>,
    risk: 'edit',
    timeoutS: 120,
  },
  {
    name: 'view',
    title: 'Picture or move the view',
    description:
      'A picture of what this window shows (picture: its viewer; on Home a drawing of the window), or moves the view: fit, normal_to or orbit about a face, hide/show faces or bodies, show_all, edges or legend on/off. Unused: target_ids [], aspect "view", size "small", with_legend true, on false, save false. Waits while the person drags or uses the Filters panel.',
    inputSchema: CORE_VIEW_SCHEMA as unknown as Record<string, unknown>,
    risk: 'read',
    timeoutS: 60,
  },
  {
    name: 'keybinds',
    title: 'Read the keyboard shortcuts',
    description:
      "The person's keyboard shortcuts, as Settings → Keybinds lists them: the app's own (only the Assistant panel's, app.assistant, can be changed) and each plugin's commands with their keys now (stored: \"Shift+KeyR\"; shown: \"Shift+R\"), defaults and where each works. plugin \"\" and target \"\" for all; plugin \"app\" for the app's. Read them any time; set_in says where the person changes one.",
    inputSchema: CORE_KEYBINDS_SCHEMA as unknown as Record<string, unknown>,
    risk: 'read',
    timeoutS: 30,
  },
  {
    name: 'set_keybind',
    title: 'Change a keyboard shortcut',
    description:
      "Changes a shortcut as Settings → Keybinds does: a plugin's command, or the Assistant panel's key (plugin \"app\", command \"app.assistant\"). set (keys: one key, e.g. \"Shift+R\"), reset, clear, reset_all. Only if the person explicitly asked in this request (person_asked, else not_asked); they confirm (No: step_declined). Another command's key: key_taken unless replace; moved meanwhile: changed.",
    inputSchema: CORE_SET_KEYBIND_SCHEMA as unknown as Record<string, unknown>,
    risk: 'edit',
    timeoutS: 300,
  },
]);
