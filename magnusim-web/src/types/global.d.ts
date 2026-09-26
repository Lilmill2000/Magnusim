export {};

declare module '*.html?raw' {
  const content: string;
  export default content;
}

type ViewerHandle = {
  renderer: unknown;
  renderWindow: { render: () => void };
  interactor: unknown;
};

declare global {
  interface Window {
    __cfdViewer?: import('../viewer/index').ViewerApi;
    __cfdProject?: unknown;
    __cfdJobs?: unknown;
    __CFD_VIEW__?: ViewerHandle;
    __CFD_RESIZE_VIEWER__?: () => void;
    __CFD_HYDRATE_PROJECT__?: (id: string, opts?: { show?: boolean }) => Promise<unknown>;
    __CFD_PROJECT_OPEN_BEGIN__?: () => void;
    __CFD_PROJECT_OPEN_END__?: () => void;
    __CFD_PREPARE_PROJECT_SWITCH__?: (id: string) => void;
    __CFD_LEAVE_WORKBENCH__?: () => void;
    __CFD_PROJECT_READY__?: string;
    __CFD_PREFS__?: Record<string, unknown>;
    __CFD_RUN_SCOPE__?: string;
    __CFD_MESH_VIEW__?: { bounds?: number[]; case_dir?: string };
    __CFD_HOST_SURFACES__?: {
      setLegendRange: (lo: number, hi: number) => void;
      setTimeline: (time: string) => Promise<unknown>;
      timelineTimes: () => string[];
      inspect: (casePos: number[]) => Promise<unknown>;
      compareRuns: (runA: string, runB: string) => Promise<unknown>;
    };
    __CFD_PLUGIN_UI__?: typeof import('../plugin-api').pluginUi;
    __CFD_REACT__?: typeof import('react');
    __CFD_REACT_DOM__?: typeof import('react-dom/client');
    __CFD_LOAD_PLUGIN_UI__?: (plugin: import('../plugins/loader').ListedPlugin) => Promise<void>;
    __CFD_SINGLE_REACT__?: boolean;
    __CFD_PLUGINS_READY__?: boolean;
    __CFD_REPLACE_PANEL__?: (panelId: string, mode: 'ok' | 'throw') => void;
    __CFD_REGISTER_FILTER__?: (title: string) => void;
    __CFD_TREE_TRANSFORM__?: (fn: (nodes: import('../plugin-api').PluginTreeNode[]) => import('../plugin-api').PluginTreeNode[]) => void;
    __CFD_W16__?: { project?: { id?: string }; geometry?: unknown };
    __CFD_W16_STATE__?: Record<string, unknown>;
    __CFD_TREE_UI__?: { openPanel?: string | null; expanded?: Record<string, boolean>; selectedKey?: string | null };
    __CFD_EXPAND_HYDRATED_TREE__?: () => void;
    __CFD_W20_STATE__?: Record<string, unknown>;
    __CFD_W17_DEFAULTS__?: {
      analysis: string;
      analysis_type?: string;
      turbulence_model: string;
      time_dependency: string;
      algorithm: string;
    };
    __CFD_W17__?: unknown;
    __CFD_W17_STATE__?: Record<string, unknown>;
    __CFD_W18_STATE__?: unknown;
    __CFD_W19_STATE__?: unknown;
    __CFD_W20__?: unknown;
    __CFD_W21_GENERATE__?: (
      opts?: import('../panels/legacyBridge').MeshGenerateOptions,
    ) => Promise<unknown>;
    __CFD_WATCH_JOB__?: (jobId: string) => void;
    /* Island bridge: see src/panels/legacyBridge.ts */
    __CFD_OPEN_TREE_DETAIL__?: (key: string, opts?: { toggle?: boolean }) => boolean;
    __CFD_OPEN_BC__?: (id: string) => boolean;
    __CFD_RUN_STATE__?: import('../panels/legacyBridge').RunState;
    __CFD_RUN_STATE_NOW__?: () => import('../panels/legacyBridge').RunState | null;
    __CFD_RUN_SAVE__?: (patch: { end_time?: number; write_interval?: number }) => Promise<unknown>;
    __CFD_RUN_TRANSIENT_SAVE__?: (t: import('../panels/legacyBridge').TransientSettings) => Promise<unknown>;
    __CFD_RUN_TRANSIENT_RESET__?: () => Promise<unknown>;
    __CFD_RUN_RENAME__?: (name: string) => Promise<unknown>;
    __CFD_RUN_DELETE__?: () => Promise<unknown>;
    __CFD_RUN_COPY_PICK__?: (on: boolean) => void;
    __CFD_RUN_COPY_FROM__?: (runId: string) => Promise<unknown>;
    __CFD_RUN_SETUP_FIX__?: () => void;
    __CFD_STUDY_STATE__?: import('../panels/legacyBridge').StudyState;
    __CFD_GEOMETRY_STATE__?: import('../panels/legacyBridge').GeometryState;
    __CFD_GEOMETRY_STATE_NOW__?: () => import('../panels/legacyBridge').GeometryState | null;
    __CFD_GEOMETRY_DELETE__?: () => Promise<boolean>;
    __CFD_STUDY_STATE_NOW__?: () => import('../panels/legacyBridge').StudyState | null;
    __CFD_STUDY_UPDATE__?: (patch: Record<string, unknown>) => Promise<unknown>;
    __CFD_STUDY_TIME__?: (value: import('../panels/legacyBridge').TimeDependency) => Promise<unknown>;
    __CFD_STUDY_DELETE__?: () => Promise<unknown>;
    __CFD_MESH_SAVE__?: (meshId: string | undefined, settings: Record<string, unknown>) => Promise<unknown>;
    __CFD_PROJECT_UNITS__?: () => string | null;
    __CFD_BC_FLOW_BASIS__?: (faces: string[]) => { face_area_m2: number | null; density: number };
    __CFD_CREATE_PICK_ANALYSIS__?: (row: { label?: string; time_dependency?: string }) => void;
    __CFD_MATERIAL_APPLY__?: (material: Record<string, unknown>, projectId?: string) => unknown;
    __CFD_MATERIAL_DELETE__?: () => Promise<unknown>;
    __CFD_GEOMETRY_BODIES__?: () => string[];
    __CFD_BCS__?: import('../panels/legacyBridge').BcState;
    __CFD_BC_STATE__?: () => import('../panels/legacyBridge').BcState;
    __CFD_BC_OPEN_PICKER__?: () => void;
    __CFD_BC_OPEN_DEFAULTS__?: () => void;
    __CFD_BC_CREATE__?: (bcType: string) => Promise<unknown>;
    __CFD_BC_UPDATE__?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
    __CFD_BC_DELETE__?: (id: string) => Promise<unknown>;
    __CFD_BC_UNASSIGN_FACE__?: (face: string) => void;
    __CFD_BC_FOCUS_FACE__?: (face: string) => void;
    __CFD_BC_CLEAR_FACES__?: () => Promise<unknown>;
    __CFD_MESH_GENERATE_CLICK__?: (
      opts?: import('../panels/legacyBridge').MeshGenerateOptions,
    ) => Promise<unknown>;
    __CFD_DELETE_MESH__?: () => Promise<unknown>;
    __CFD_MESH_RENAME__?: (name: string) => Promise<string>;
    __CFD_MESH_RESTORE_DEFAULTS__?: () => Promise<unknown>;
    __CFD_MESH_OPEN_SETTINGS__?: (meshId?: string) => void;
    __CFD_MESH_COPY_PICK__?: (on: boolean, destId?: string) => void;
    __CFD_COPY_MESH_SETTINGS__?: (sourceId: string) => Promise<unknown>;
    __CFD_MESH_JOB__?: import('../panels/legacyBridge').MeshJobState;
    __CFD_MESH_COPY__?: import('../panels/legacyBridge').MeshCopyState;
    __CFD_SIM_START__?: () => Promise<unknown>;
    __CFD_SIM_STOP__?: () => Promise<unknown>;
    __CFD_REFRESH_TREE__?: () => void;
    __CFD_RUN_GATE__?: (
      runId?: string,
    ) => import('../panels/legacyBridge').RunGateState | null;
    __CFD_W26_STATE__?: unknown;
    __CFD_W27_STATE__?: unknown;
    __CFD_JOB_ACTIVITY__?: {
      kind?: string | null;
      mesh_id?: string | null;
      run_id?: string | null;
      queue?: Array<{ kind?: string; mesh_id?: string | null; run_id?: string | null }>;
    };
    __CFD_MESH_DRAFT__?: Record<string, unknown>;
    __CFD_MESH_DRAFTS__?: Record<string, Record<string, unknown>>;
    __CFD_HOME__?: {
      show: () => void;
      hide: () => void;
      refresh: () => Promise<unknown>;
      open: (id: string) => Promise<unknown>;
      prepareCreateModal?: () => void;
      folderValueFromCreateModal?: () => string;
      submitProjectModal?: () => Promise<unknown>;
    };
    __CFD_OPEN_WIZARD__?: (opts?: { required?: boolean }) => void;
    __CFD_APPLY_WB_STAGE__?: () => void;
    __CFD_ADD_MATERIAL__?: (simId?: string) => void | Promise<unknown>;
    __CFD_ADD_BC__?: (simId?: string) => void | Promise<unknown>;
  }
}
