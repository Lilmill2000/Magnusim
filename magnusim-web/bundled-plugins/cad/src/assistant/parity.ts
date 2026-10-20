// The parity table (Daniel's rule: anything a person can do, use or see in the CAD program, the
// Assistant can do through its tools). Every person-facing capability, by where the program keeps
// it, names the Assistant tool and field that reach it:
//   COMMANDS          every command of the registry (the toolbar, the context menus and the keyboard
//                     run them by id), by id;
//   FEATURE_FIELDS    every field of every feature type's record (types/doc.ts), by type;
//   SKETCH_ENTITIES, SKETCH_CONSTRAINTS, SKETCH_TOOLS  what sketch mode draws, ties and offers;
//   UI, DOC, RAILS, TOOLBAR, LINK, VIEWPORT  the methods the person's controls call (the tree, the
//                     chips, the panels' rails, the toolbar layout, Back's link, the view).
// The records keyed by types are exhaustive at typecheck (a new feature field, entity kind, sketch
// tool or method fails `npm run typecheck` until it is mapped); tests/assistant/parity.test.ts
// checks the same at run time against the booted app (every registered command, feature type and
// default field) and that every mapping names a tool and field that exist in schemas.ts.
// A mapping is one of:
//   reach(tool, field, value?)    the Assistant reaches it now (field: a property path of the tool's
//                                 input, "entities[].kind"; value: the enum value, when one);
//   auto(why)                     not a person action: automatic, internal, or only a pointer's way
//                                 to something mapped elsewhere (the why says which).
// Not imported by the app (tests and typecheck only).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { LinkController } from '../link/controller';
import type { FeatureOf, FeatureType, SketchDimensionKind, SketchEntity, SketchRelationKind } from '../types/doc';
import type { DocService } from '../types/doc-service';
import type { SketchToolId } from '../types/sketch';
import type { ViewportHandle } from '../types/viewport';
import type { UiController } from '../ui/controller';
import type { Rails } from '../ui/left-rails';
import type { ToolbarPrefs } from '../ui/toolbar-layout';

export type Reach =
  | { kind: 'reach'; tool: string; field: string; value?: string }
  | { kind: 'auto'; why: string };

export const reach = (tool: string, field: string, value?: string): Reach => ({ kind: 'reach', tool, field, ...(value !== undefined ? { value } : {}) });
export const auto = (why: string): Reach => ({ kind: 'auto', why });

const W = (action: string) => reach('workspace', 'action', action);
const ENTITY = (kind: string) => reach('sketch', 'entities[].kind', kind);
const TIE = (kind: string) => reach('sketch', 'constraints[].kind', kind);
const MODIFY = (kind: string) => reach('modify', 'kind', kind);
const PATTERN = (kind: string) => reach('pattern', 'kind', kind);
// Construction geometry (construct), direct edits, the enclosure, repair and retry (direct), and
// the person's sketch tools (sketch's constraint rows: trim, offset, the patterns, project...).
const CONSTRUCT = (field: string, value?: string) => reach('construct', field, value);
const DIRECT = (kind: string) => reach('direct', 'kind', kind);
const DIRECT_FIELD = (field: string) => reach('direct', field);
const SKETCH_OP = (kind: string) => TIE(kind);
const REPAIR = DIRECT('repair');

// ------------------------------------------------------------------ commands, by id

export const COMMANDS: Readonly<Record<string, Reach>> = {
  'edit.undo': reach('undo', 'action', 'undo'),
  'edit.redo': reach('undo', 'action', 'redo'),
  'view.fit': W('fit'),
  'view.front': W('standard_view'),
  'view.back': W('standard_view'),
  'view.left': W('standard_view'),
  'view.right': W('standard_view'),
  'view.top': W('standard_view'),
  'view.bottom': W('standard_view'),
  'view.iso': W('standard_view'),
  'view.normal-to': W('normal_to'),
  'modify.parameters': reach('set_params', 'set'),
  'modify.chamfer': MODIFY('chamfer'),
  'modify.fillet': MODIFY('fillet'),
  'modify.shell': MODIFY('shell'),
  'modify.combine': reach('combine', 'op'),
  'modify.delete-faces': DIRECT('delete_faces'),
  'modify.press-pull': DIRECT('press_pull'),
  'modify.split': DIRECT('split'),
  'inspect.check': reach('measure', 'targets'),
  'inspect.mass': reach('measure', 'targets'),
  'inspect.measure': reach('measure', 'targets'),
  'cfd.enclosure': DIRECT('enclosure'),
  'file.export-step': W('export_step'),
  'file.import-step': W('import_step'),
  'solid.extrude': reach('extrude', 'extent'),
  'solid.revolve': reach('revolve', 'axis'),
  'solid.sweep': reach('sweep_loft', 'kind', 'sweep'),
  'solid.loft': reach('sweep_loft', 'kind', 'loft'),
  'pattern.linear': PATTERN('linear'),
  'pattern.circular': PATTERN('circular'),
  'pattern.mirror': PATTERN('mirror'),
  'construct.plane': CONSTRUCT('method', 'offset'),
  'construct.axis': CONSTRUCT('method', 'two_points'),
  'construct.point': CONSTRUCT('method', 'vertex'),
  'scale.banana': W('banana_show'),
  'scale.sketch-banana': W('banana_show'),
  'sketch.new': reach('sketch', 'on'),
  'sketch.line': ENTITY('line'),
  'sketch.rectangle': ENTITY('rect'),
  'sketch.rectangle-center': ENTITY('center_rect'),
  'sketch.circle': ENTITY('circle'),
  'sketch.arc': ENTITY('arc'),
  'sketch.arc-tangent': TIE('tangent'),
  'sketch.point': ENTITY('point'),
  'sketch.centerline': ENTITY('centerline'),
  'sketch.construction': reach('sketch', 'entities[].construction'),
  'sketch.coincident': TIE('coincident'),
  'sketch.horizontal': TIE('horizontal'),
  'sketch.vertical': TIE('vertical'),
  'sketch.parallel': TIE('parallel'),
  'sketch.perpendicular': TIE('perpendicular'),
  'sketch.tangent': TIE('tangent'),
  'sketch.equal': TIE('equal'),
  'sketch.midpoint': TIE('midpoint'),
  'sketch.symmetric': TIE('symmetric'),
  'sketch.concentric': TIE('concentric'),
  'sketch.collinear': TIE('collinear'),
  'sketch.fix': TIE('fix'),
  'sketch.dimension': TIE('distance'),
  'sketch.trim': SKETCH_OP('trim'),
  'sketch.extend': SKETCH_OP('extend'),
  'sketch.finish': auto('the sketch tool finishes the sketch it makes; the person finishes their own'),
  'sketch.delete': reach('sketch', 'entities'),
  'sketch.undo': reach('undo', 'action', 'undo'),
  'sketch.redo': reach('undo', 'action', 'redo'),
  'view.sketch-look': W('normal_to'),
  'view.sketch-relations': reach('get_model', 'feature'),
  'sketch.project': SKETCH_OP('project'),
  'sketch.intersect': SKETCH_OP('intersect'),
  'sketch.spline': ENTITY('spline'),
  'sketch.spline-control': ENTITY('control_spline'),
  'sketch.mirror': SKETCH_OP('mirror'),
  'sketch.pattern-linear': SKETCH_OP('linear_pattern'),
  'sketch.pattern-circular': SKETCH_OP('circular_pattern'),
  'sketch.offset': SKETCH_OP('offset'),
  'sketch.fillet': SKETCH_OP('fillet'),
  'sketch.chamfer': SKETCH_OP('chamfer'),
  'sketch.enter': auto("Enter places a point or finishes the tool in use: a pointer step of the person's"),
  'sketch.curve-pick': auto("a pick of the person's for Project and Intersect (sketch.project, sketch.intersect)"),
};

// ------------------------------------------------------------------ every feature field, by type

/** The fields every feature has, and those of body-making features. */
const BASE = {
  id: auto('internal id, fixed when made'),
  type: auto('chosen by the tool that makes it'),
  name: reach('edit_feature', 'rename_to'),
  suppressed: reach('edit_feature', 'suppress'),
} as const;
const BODY = (tool: string) => ({
  op: reach(tool, 'op'),
  creates: reach(tool, 'body_name'),
  scope: reach(tool, 'bodies'),
  repair: REPAIR,
});
const PATTERN_COMMON = {
  of: reach('pattern', 'of'),
  features: reach('pattern', 'items'),
  bodies: reach('pattern', 'items'),
  faceBody: reach('pattern', 'items'),
  faces: reach('pattern', 'items'),
  op: reach('pattern', 'op'),
  creates: auto('op new names its body Body N; body rename_to names it'),
  scope: reach('pattern', 'bodies'),
  skip: reach('pattern', 'skip'),
  repair: REPAIR,
};

type FieldsOf<T extends FeatureType> = { readonly [K in keyof Required<FeatureOf<T>>]: Reach };
export type FeatureFields = { readonly [T in FeatureType]: FieldsOf<T> };

export const FEATURE_FIELDS: FeatureFields = {
  sketch: {
    ...BASE,
    support: reach('sketch', 'on'),
    plane: reach('sketch', 'on'),
    points: reach('sketch', 'entities[].at'),
    entities: reach('sketch', 'entities'),
    constraints: reach('sketch', 'constraints'),
    solved: auto("the solver's state (get_model reads it)"),
    links: SKETCH_OP('project'),
    ties: SKETCH_OP('linear_pattern'),
  },
  extrude: {
    ...BASE,
    ...BODY('extrude'),
    profiles: reach('extrude', 'regions'),
    extent: reach('extrude', 'extent'),
    flip: reach('extrude', 'flip'),
    face: reach('extrude', 'face'),
    direction: reach('extrude', 'direction'),
  },
  revolve: {
    ...BASE,
    ...BODY('revolve'),
    profiles: reach('revolve', 'regions'),
    axis: reach('revolve', 'axis'),
    extent: reach('revolve', 'extent'),
    flip: reach('revolve', 'flip'),
  },
  sweep: {
    ...BASE,
    ...BODY('sweep_loft'),
    profiles: reach('sweep_loft', 'profiles'),
    path: reach('sweep_loft', 'path'),
    orientation: reach('sweep_loft', 'orientation'),
  },
  loft: {
    ...BASE,
    ...BODY('sweep_loft'),
    sections: reach('sweep_loft', 'profiles'),
    ruled: reach('sweep_loft', 'ruled'),
  },
  fillet: { ...BASE, body: reach('modify', 'targets'), edges: reach('modify', 'targets'), faces: reach('modify', 'targets'), radius: reach('modify', 'size') },
  chamfer: {
    ...BASE,
    body: reach('modify', 'targets'),
    edges: reach('modify', 'targets'),
    faces: reach('modify', 'targets'),
    mode: reach('modify', 'size2'),
    distance: reach('modify', 'size'),
    distance2: reach('modify', 'size2'),
    flip: reach('modify', 'flip'),
  },
  shell: { ...BASE, body: reach('modify', 'targets'), faces: reach('modify', 'targets'), thickness: reach('modify', 'size'), direction: reach('modify', 'inward') },
  combine: { ...BASE, op: reach('combine', 'op'), targets: reach('combine', 'targets'), tools: reach('combine', 'tools'), keepTools: reach('combine', 'keep_tools'), repair: REPAIR },
  import: {
    ...BASE,
    source: W('import_step'),
    brep: auto('the healed copy the import stores'),
    heal: W('reheal'),
    items: auto("the STEP's own bodies"),
    diagnostics: auto('what the heal found (get_model full reads it)'),
    origin: auto('Edit in CAD: the project geometry the Part was opened on'),
  },
  delete_faces: { ...BASE, body: DIRECT_FIELD('faces'), faces: DIRECT_FIELD('faces'), repair: REPAIR },
  press_pull: { ...BASE, body: DIRECT_FIELD('faces'), faces: DIRECT_FIELD('faces'), distance: DIRECT_FIELD('distance'), repair: REPAIR, version: auto('the build version a saved press-pull keeps') },
  split: { ...BASE, targets: DIRECT_FIELD('bodies'), tool: DIRECT_FIELD('tool'), repair: REPAIR },
  enclosure: {
    ...BASE,
    shape: DIRECT_FIELD('shape'),
    axis: reach('direct', 'shape', 'cylinder_z'),
    bodies: DIRECT_FIELD('bodies'),
    padding: DIRECT_FIELD('padding'),
    percent: DIRECT_FIELD('distance'),
    distance: DIRECT_FIELD('distance'),
    sides: DIRECT_FIELD('sides'),
    creates: auto('the body it makes, fixed when made (body rename_to names it)'),
  },
  ref_plane: {
    ...BASE,
    method: CONSTRUCT('method'),
    plane: CONSTRUCT('refs'),
    plane2: CONSTRUCT('refs'),
    axis: CONSTRUCT('refs'),
    points: CONSTRUCT('refs'),
    edge: CONSTRUCT('refs'),
    distance: CONSTRUCT('value'),
    angle: CONSTRUCT('value'),
    percent: CONSTRUCT('value'),
    flip: CONSTRUCT('flip'),
  },
  ref_axis: { ...BASE, method: CONSTRUCT('method'), points: CONSTRUCT('refs'), face: CONSTRUCT('refs'), edge: CONSTRUCT('refs'), planes: CONSTRUCT('refs'), flip: CONSTRUCT('flip') },
  ref_point: {
    ...BASE,
    method: CONSTRUCT('method'),
    vertex: CONSTRUCT('refs'),
    edge: CONSTRUCT('refs'),
    face: CONSTRUCT('refs'),
    plane: CONSTRUCT('refs'),
    along: CONSTRUCT('value'),
    distance: CONSTRUCT('value'),
    percent: CONSTRUCT('value'),
    fromEnd: CONSTRUCT('from_end'),
    xyz: CONSTRUCT('xyz'),
  },
  pattern_linear: { ...BASE, ...PATTERN_COMMON, dir1: reach('pattern', 'about'), dir2: reach('pattern', 'about2') },
  pattern_circular: {
    ...BASE,
    ...PATTERN_COMMON,
    axis: reach('pattern', 'about'),
    flip: reach('pattern', 'flip'),
    count: reach('pattern', 'count'),
    mode: reach('pattern', 'spacing'),
    angle: reach('pattern', 'spacing'),
    symmetric: reach('pattern', 'options', 'symmetric'),
  },
  mirror: { ...BASE, ...PATTERN_COMMON, plane: reach('pattern', 'about') },
};

// ------------------------------------------------------------------ sketch mode

export const SKETCH_ENTITIES: { readonly [K in SketchEntity['kind']]: Reach } = {
  point: ENTITY('point'),
  line: ENTITY('line'),
  circle: ENTITY('circle'),
  arc: ENTITY('arc'),
  spline: ENTITY('spline'),
};

export const SKETCH_CONSTRAINTS: { readonly [K in SketchRelationKind | SketchDimensionKind]: Reach } = {
  coincident: TIE('coincident'),
  horizontal: TIE('horizontal'),
  vertical: TIE('vertical'),
  parallel: TIE('parallel'),
  perpendicular: TIE('perpendicular'),
  tangent: TIE('tangent'),
  equal: TIE('equal'),
  midpoint: TIE('midpoint'),
  symmetric: TIE('symmetric'),
  point_on_line: TIE('point_on'),
  point_on_circle: TIE('point_on'),
  concentric: TIE('concentric'),
  collinear: TIE('collinear'),
  fix: TIE('fix'),
  distance: TIE('distance'),
  distance_x: TIE('distance_x'),
  distance_y: TIE('distance_y'),
  radius: TIE('radius'),
  diameter: TIE('diameter'),
  angle: TIE('angle'),
};

export const SKETCH_TOOLS: { readonly [K in SketchToolId]: Reach } = {
  select: auto("the person's pointer; the Assistant names sketch geometry by id"),
  line: ENTITY('line'),
  'rectangle-corner': ENTITY('rect'),
  'rectangle-center': ENTITY('center_rect'),
  circle: ENTITY('circle'),
  'arc-3pt': ENTITY('arc'),
  'arc-tangent': TIE('tangent'),
  point: ENTITY('point'),
  centerline: ENTITY('centerline'),
  dimension: TIE('distance'),
  trim: SKETCH_OP('trim'),
  extend: SKETCH_OP('extend'),
  'spline-fit': ENTITY('spline'),
  'spline-control': ENTITY('control_spline'),
  mirror: SKETCH_OP('mirror'),
  'pattern-linear': SKETCH_OP('linear_pattern'),
  'pattern-circular': SKETCH_OP('circular_pattern'),
  offset: SKETCH_OP('offset'),
  fillet: SKETCH_OP('fillet'),
  chamfer: SKETCH_OP('chamfer'),
  project: SKETCH_OP('project'),
  intersect: SKETCH_OP('intersect'),
};

// ------------------------------------------------------------------ the person's controls, by method

const INTERNAL = auto('internal plumbing, no control of its own');
const HAND_OFF = auto("the Assistant's own hand-off path (the edit tools use it)");
const MENU = auto('a menu: each of its items is mapped by what it runs');

export const UI: { readonly [K in keyof UiController]: Reach } = {
  state: INTERNAL,
  editBlock: INTERNAL,
  addEditBlock: INTERNAL,
  openNew: reach('extrude', 'edit'),
  openTool: W('export_step'),
  openEdit: reach('edit_feature', 'feature'),
  openParams: reach('set_params', 'set'),
  closePanel: auto("the Assistant's panels close with their call; the person's are theirs"),
  cancelPanel: auto("the Assistant's panels close with their call; the person's are theirs"),
  deletePanelFeature: reach('delete', 'features'),
  setPanelNote: INTERNAL,
  renameFeature: reach('edit_feature', 'rename_to'),
  renameBody: reach('body', 'rename_to'),
  startRename: reach('edit_feature', 'rename_to'),
  endRename: reach('edit_feature', 'rename_to'),
  toggleSuppressed: reach('edit_feature', 'suppress'),
  runFeatureAction: REPAIR,
  deleteFeature: reach('delete', 'features'),
  rollBackTo: W('roll_back_to'),
  rollToEnd: W('roll_to_end'),
  setRollbackIndex: W('roll_back_to'),
  setBodyVisible: reach('body', 'visibility'),
  setBodyInSimulation: reach('body', 'simulation'),
  featureMenu: MENU,
  bodyMenu: MENU,
  showMenu: MENU,
  closeMenu: MENU,
  featureOfItem: INTERNAL,
  fail: INTERNAL,
  openForAssistant: HAND_OFF,
  openEditForAssistant: HAND_OFF,
  openParamsForAssistant: HAND_OFF,
  doneForAssistant: HAND_OFF,
  dropForAssistant: HAND_OFF,
  dispose: INTERNAL,
};

export const DOC: { readonly [K in keyof DocService]: Reach } = {
  state: reach('get_model', 'detail'),
  units: reach('set_params', 'set'),
  features: INTERNAL,
  load: INTERNAL,
  editable: reach('get_model', 'detail'),
  beginNew: reach('extrude', 'edit'),
  beginEdit: reach('edit_feature', 'feature'),
  session: INTERNAL,
  rename: reach('edit_feature', 'rename_to'),
  setSuppressed: reach('edit_feature', 'suppress'),
  suppressRemoved: reach('edit_feature', 'suppress'),
  remove: reach('delete', 'features'),
  removeBlock: reach('delete', 'features'),
  move: reach('edit_feature', 'move'),
  renameBody: reach('body', 'rename_to'),
  setBodyColor: reach('body', 'color'),
  setBodyInSimulation: reach('body', 'simulation'),
  addParam: reach('set_params', 'set'),
  updateParam: reach('set_params', 'set'),
  removeParam: reach('set_params', 'remove'),
  editParams: reach('set_params', 'set'),
  undo: reach('undo', 'action', 'undo'),
  redo: reach('undo', 'action', 'redo'),
  repair: REPAIR,
  retry: DIRECT('retry'),
  setRollback: W('roll_back_to'),
  setBodyVisible: reach('body', 'visibility'),
  setExpanded: W('expand'),
  setPlanes: W('origin_planes'),
  setCamera: auto('the view keeps its camera by itself'),
  setSketchVisibility: W('show'),
  setScaleModel: W('banana_place'),
  setSketchBanana: W('banana_place'),
  measure: reach('measure', 'targets'),
  flush: INTERNAL,
  retellDirty: INTERNAL,
  retrySave: W('retry_save'),
  holdSaves: INTERNAL,
  checkStored: INTERNAL,
  reload: W('reload'),
  keepMine: W('keep_mine'),
  bodiesAtEnd: W('send_to_simulation'),
  bodiesBefore: INTERNAL,
  settled: INTERNAL,
  committed: INTERNAL,
  recordSettled: INTERNAL,
  assistant: HAND_OFF,
  dispose: INTERNAL,
};

export const RAILS: { readonly [K in keyof Rails]: Reach } = {
  state: INTERNAL,
  treeIsRail: INTERNAL,
  setTreeShown: W('collapse'),
  sketchChanged: INTERNAL,
  setSketchCollapsed: W('collapse'),
  setSketchDetails: W('expand'),
  focusAfter: INTERNAL,
  takeFocus: INTERNAL,
};

export const TOOLBAR: { readonly [K in keyof ToolbarPrefs]: Reach } = {
  state: INTERNAL,
  loaded: INTERNAL,
  setMode: W('toolbar_move'),
  reset: W('toolbar_reset'),
  saved: INTERNAL,
};

export const LINK: { readonly [K in keyof LinkController]: Reach } = {
  sync: W('send_to_simulation'),
  running: INTERNAL,
  last: W('send_to_simulation'),
};

const POINTER = auto("the person's pointer in the view (orbit, pick, hover): the Assistant names things by selector");

export const VIEWPORT: { readonly [K in keyof ViewportHandle]-?: Reach } = {
  state: reach('workspace', 'action', 'display'),
  setBodies: INTERNAL,
  setVisibility: reach('body', 'visibility'),
  setVertices: INTERNAL,
  highlight: W('select'),
  flash: reach('find', 'query'),
  setFilter: W('selection_filter'),
  onPick: POINTER,
  onBoxSelect: W('select'),
  boxSelect: W('select'),
  fit: W('fit'),
  setView: W('standard_view'),
  lookAt: W('normal_to'),
  setDisplay: W('display'),
  setProjection: W('projection'),
  setSection: W('section'),
  setPlanes: W('origin_planes'),
  setPlanesBusy: INTERNAL,
  setPlanesWanted: INTERNAL,
  sectionRange: W('section'),
  pick: POINTER,
  pickKinds: POINTER,
  project: INTERNAL,
  planeNormal: W('normal_to'),
  orbitAround: W('orbit_pivot'),
  orbitPivot: W('orbit_pivot'),
  camera: auto('the camera itself: moved through the view actions'),
  setCamera: auto('the camera itself: moved through the view actions'),
  userCameraMoves: auto("the camera latch's count"),
  snapshot: reach('view', 'views'),
  onCameraChange: INTERNAL,
  stats: INTERNAL,
  measure: INTERNAL,
  addLayer: INTERNAL,
  reframe: W('fit'),
  refitIfOffScreen: W('fit'),
  pushTool: POINTER,
  rayAt: POINTER,
  toPlane: POINTER,
  pixelSize: INTERNAL,
  onFrame: INTERNAL,
  lineResolution: INTERNAL,
  dispose: INTERNAL,
};

/** Every table, by name (the test walks them all). */
export const PARITY_TABLES: Readonly<Record<string, Readonly<Record<string, Reach>>>> = {
  commands: COMMANDS,
  ...Object.fromEntries(Object.entries(FEATURE_FIELDS).map(([t, f]) => [`feature ${t}`, f as Readonly<Record<string, Reach>>])),
  'sketch entities': SKETCH_ENTITIES,
  'sketch constraints': SKETCH_CONSTRAINTS,
  'sketch tools': SKETCH_TOOLS,
  ui: UI,
  doc: DOC,
  rails: RAILS,
  toolbar: TOOLBAR,
  link: LINK,
  viewport: VIEWPORT,
};
