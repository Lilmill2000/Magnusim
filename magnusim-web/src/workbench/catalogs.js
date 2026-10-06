/** Study catalogs for the setup islands. The workbench reads these; it does not own the W17–W20 blocks. */

export const studyCatalog = {
  increment: 'W17',
  ready: false,
  simulation: null,
  simulations: [],
  activeId: null,
  defaults: null,
  project_id: null,
  note: '',
  soft_pass_avoided: true,
};

export const materialCatalog = {
  ready: false,
  hydrated: false,
  created: false,
  libraryApplied: false,
  project_id: null,
  material: null,
  materials_all: [],
  draft_volumes: [],
  materials_json: null,
  note: '',
};

export const bcCatalog = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  bcs: [],
  bcs_all: [],
  defaults: { wall_type: 'No-slip' },
  defaults_by_simulation: {},
  activeId: null,
  draft_faces: [],
  focusFace: null,
  boundary_conditions_json: null,
  note: '',
};

export const resultCatalog = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  area_average_1: null,
  draft_faces: [],
  focusFace: null,
  panel_open: false,
  editing_run_id: null,
  editing_rc_id: null,
  read_only: false,
  result_controls_json: null,
  area_average_json: null,
  note: '',
};

export const refinementCatalog = {
  ready: false,
  hydrated: false,
  project_id: null,
  refinements: [],
  activeId: null,
  meshId: null,
  draft_faces: [],
  focusFace: null,
  note: '',
};

export const runCatalog = {
  // Steady iterations / write interval of the selected run. No default here: the
  // registry's (runtime.js steadyDefaultsClient) fills them once it loads.
  endTime: null,
  writeInterval: null,
  // Steady settings typed but not saved yet, per run id ({ endTime, writeInterval }).
  pending_control: {},
  // A Cores choice not saved yet, per run id ({ cores }: a whole number, or null for Auto).
  pending_cores: {},
  // A "Stop when settled" edit not saved yet, per run id ({ settle }: the setting, or null for Off).
  pending_settle: {},
  // The run-settings save in flight per run id (saves go out one at a time).
  settings_saves: {},
  steady_defaults: null,
  run: null,
  runs: [],
  runs_all: [],
  meshes: [],
  selected_run_id: null,
  active_run_id: null,
  live_run_id: null,
  live_run: null,
  rc_target_run_id: null,
  poll_timer: null,
  elapsed_timer: null,
  attaching: false,
  start_error: null,
  start_error_run_id: null,
  start_error_study_id: null,
  starting: false,
  transient: null,
  transient_preview: null,
  transient_preview_key: '',
  transient_preview_timer: null,
};

export const meshCatalog = {
  ready: false,
  hydrated: false,
  created: false,
  project_id: null,
  mesh: null,
  settings: null,
  meshes: [],
  meshes_all: [],
  active_id: null,
  mesh_json: null,
  bank_exact: false,
  panel_open: false,
  note: '',
};
