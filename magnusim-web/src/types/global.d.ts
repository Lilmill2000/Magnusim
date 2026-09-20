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
    __CFD_W21_GENERATE__?: () => Promise<unknown>;
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
