/**
 * The types of what a plugin's in-page UI gets: the `host` object its
 * `register(host)` receives. Types only: nothing here runs, and a plugin never
 * imports it at run time (`import type` only).
 *
 * `npm run gen:plugin-sdk` publishes these as docs/plugins/plugin-api.d.ts
 * (module '@magnusim/plugin-api'), and `npm run gen:plugin-docs` lists them in
 * docs/plugins/API.md. src/plugin-api/public.conformance.ts holds the real
 * host object to these types, so they cannot drift from what the page passes.
 */
import type { ComponentType, ReactNode } from 'react';
import type * as ReactModule from 'react';
import type * as ReactDomClient from 'react-dom/client';
import type * as Kit from '../plugin-ui';
import type { FieldWidgetProps } from '../plugin-ui';
import type { SciNumberInputProps } from '../plugin-ui/controls/SciNumberInput';
import type { BcSettingsProps, RunSettingsProps, StudySettingsProps } from './slots';

export type { BcSettingsProps, RunSettingsProps, StudySettingsProps } from './slots';
export type { BcRecord, RunState, StudyState, TimeDependency } from '../panels/legacyBridge';
export type { BcFamilyRow, RegistryRow } from '../api/registry.gen';
export type { FieldWidgetProps, SciNumberInputProps };

/**
 * Where a registered panel is drawn: `filters` (the Filters panel) or `prefs`
 * (the plugin's row in Settings → Plugins). Any other place is refused.
 */
export type PanelPlace = 'filters' | 'prefs';

/** A panel for registerPanel. */
export interface RegisterPanelOpts {
  /** Unique across plugins; a second panel with the same key replaces the first. */
  key: string;
  title: string;
  place: PanelPlace;
  Component: ComponentType<Record<string, unknown>>;
}

/** What a replaced host panel gets (replacePanel). */
export interface IslandProps {
  projectId?: string;
  simId?: string;
  itemId?: string;
  /** The scope id of this study or mesh. */
  scope?: string;
  panelId: string;
}

/** A row a tree transform returns. A row is kept only when it names the open project. */
export interface PluginTreeNode {
  label: string;
  /** A scope id with a `p:<project id>` part, or set projectId. */
  scope?: string;
  projectId?: string;
}

/** The kind of an app toast. */
export type PluginToastKind = 'info' | 'success' | 'error';

/** A JSON Schema object, as the registry publishes it. */
export type JsonSchema = Record<string, unknown>;

/** The core's schema form (the study panel's generic form). */
export interface SchemaFormProps {
  schema: JsonSchema;
  formData?: Record<string, unknown>;
  /** Runs on blur and Enter with the whole form's values. */
  onCommit: (values: Record<string, unknown>) => void;
  /** Runs on every change. */
  onLive?: (values: Record<string, unknown>) => void;
  onDone?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  className?: string;
  /** Leave out the Done/Delete foot when your panel draws its own. */
  hideFooter?: boolean;
  /** Rows added inside the Advanced disclosure. */
  advancedExtra?: ReactNode;
}

/** One job as the page follows it (useJob). */
export interface PluginJobMirror {
  id: string;
  status: string;
  kind?: string;
  progress?: number;
  note?: string;
  residual?: unknown;
  /** Epoch ms from the first event that reported the job running. */
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
  events: Array<Record<string, unknown>>;
}

/** The 3D view, as far as a plugin may drive it. */
export interface PluginViewer {
  /** Draw the view again. */
  render: () => void;
  /** Fit the view to its box again. */
  resize: () => void;
}

/** The API object a plugin's register(host) gets as host.pluginUi. Everything registered is recorded under the plugin's key. */
export interface PluginUi {
  /** Draw an analysis's study settings in the study panel (its contract's `ui.study_settings` names it). */
  registerStudySettings: (name: string, Component: ComponentType<StudySettingsProps>) => void;
  /** Draw an analysis's run settings in the run panel (its contract's `ui.run_settings` names it). */
  registerRunSettings: (name: string, Component: ComponentType<RunSettingsProps>) => void;
  /** Draw a BC family's fields in the BC editor (the family's `ui` names it), and optionally a line under its faces. API 1.4. */
  registerBcSettings: (
    name: string,
    Component: ComponentType<BcSettingsProps>,
    opts?: { facesNote?: ComponentType<BcSettingsProps> },
  ) => void;
  /** The core's number box that reads and writes scientific notation. */
  SciNumberInput: ComponentType<SciNumberInputProps>;
  /** Helpers for an analysis's own schemas. */
  schema: {
    /** One object schema with the properties of every part, in order. */
    mergeObjectSchemas: (parts: Array<JsonSchema | null | undefined>) => JsonSchema;
    /** The values of `data` that `schema` has properties for. */
    pickSchemaValues: (data: Record<string, unknown>, schema: JsonSchema) => Record<string, unknown>;
  };
  /** Add a panel to the Filters panel or to your row in Settings → Plugins. Any other place throws. */
  registerPanel: (opts: RegisterPanelOpts) => void;
  /** Draw a host panel with your component; turning your plugin off puts the host's back. */
  replacePanel: (panelId: string, Component: ComponentType<IslandProps>) => void;
  /** Add a widget to the Filters panel. */
  registerFilterWidget: (key: string, Component: ComponentType<Record<string, unknown>>) => void;
  /** Draw every schema field whose `x-cfddesk.widget` is `xWidget` with your component (only the control; the form draws the row). */
  registerFieldWidget: (xWidget: string, Component: ComponentType<FieldWidgetProps>) => void;
  /** The open project as the page holds it (a hook), or null. */
  useProject: () => Record<string, unknown> | null;
  /** The open study as the page holds it (a hook). */
  useSimulation: () => unknown;
  /** One job as the page follows it (a hook). */
  useJob: (id: string) => PluginJobMirror | undefined;
  /** The registry rows of one kind, or the whole registry (a hook). */
  useRegistry: (kind?: string) => unknown;
  /** The 3D view. */
  useViewer: () => PluginViewer;
  /** The user's settings as the page holds them. */
  usePrefs: () => Record<string, unknown>;
  /** The core's schema form. */
  SchemaForm: ComponentType<SchemaFormProps>;
  /** Add tree rows. A row is kept only when its scope or projectId names the open project. */
  registerTreeTransform: (fn: (nodes: PluginTreeNode[]) => PluginTreeNode[]) => void;
  /** The panels registered for a place. */
  panelsFor: (place: PanelPlace) => RegisterPanelOpts[];
  /** The plugin UI kit, the page's own copy (the same code a workspace imports as '@magnusim/plugin-ui'). API 1.3. */
  kit: typeof Kit;
  /** What a kit PanelChrome's Done calls in the page (it closes the flyout). API 1.3. */
  panelDone: () => void;
  /** An app toast, bottom right. An unknown kind is info. API 1.3. */
  toast: (message: string, opts?: { kind?: PluginToastKind }) => void;
  /** The units the open project shows (else the Settings choice). API 1.3. */
  unitSystem: () => 'metric' | 'imperial';
}

/** What a plugin's in-page `register(host)` receives. */
export interface PluginHost {
  /** The page's React. A prebuilt `.js` UI uses this instead of importing React. */
  React: typeof ReactModule;
  /** The page's react-dom/client. */
  ReactDOM: typeof ReactDomClient;
  pluginUi: PluginUi;
  /** The scope id of what was open when the UI loaded: its `p:<project id>` part names the project ('' when none was open). */
  scope: string;
}

/** The shape of a plugin UI module: the host calls its register once per load. */
export interface PluginUiModule {
  register: (host: PluginHost) => void;
}
