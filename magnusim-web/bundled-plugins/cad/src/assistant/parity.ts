// The parity table (Daniel's rule: anything a person can do, use or see in the CAD program, the
// Assistant can do through its tools). Every person-facing capability, by where the program keeps
// it, names the Assistant tool and field that reach it:
//   COMMANDS          every command of the registry (the toolbar, the context menus and the keyboard
//                     run them by id), by id;
//   FEATURE_FIELDS    every field of every feature type's record (types/doc.ts), by type;
//   SKETCH_ENTITIES, SKETCH_CONSTRAINTS, SKETCH_TOOLS  what sketch mode draws, ties and offers;
//   UI, DOC, RAILS, TOOLBAR, LINK, VIEWPORT, KEYBINDS  the methods the person's controls call (the
//                     tree, the chips, the panels' rails, the toolbar layout, Back's link, the view,
//                     the Set keybind dialog and Settings' keybinds);
//   CHECK             the Check panel's controls (src/features/check/controls.ts): its modes, fields,
//                     Stop and result rows.
// And the other way (Daniel: "anything the AI has I should have and anything I have the AI should
// have"): AI_TOOLS names, for every field of every Assistant tool and every value of its enums
// (schemas.ts), the person's way to the same thing (person paths, below); the test fails on a
// tool, field or value with no row, and on a row that names a command, control or panel field the
// booted app does not have.
// The records keyed by types are exhaustive at typecheck (a new feature field, entity kind, sketch
// tool or method fails `npm run typecheck` until it is mapped); tests/assistant/parity.test.ts
// checks the same at run time against the booted app (every registered command, feature type and
// default field) and that every mapping names a tool and field that exist in schemas.ts.
// A mapping is one of:
//   reach(tool, field, value?, note?)  the Assistant reaches it now (field: a property path of the
//                                 tool's input, "entities[].kind"; value: the enum value, when one;
//                                 note: a rule on how, as the keybind changes' "only when asked");
//   auto(why)                     not a person action: automatic, internal, or only a pointer's way
//                                 to something mapped elsewhere (the why says which).
// A row only a host with projects has (Magnusim) is marked `projects` (inProjects, onlyInProjects):
// Magnusim CAD (projectLinks false: no projects, no simulation) offers neither the person's control
// nor the Assistant's field, and parityFor(false) gives the tables as they hold there (the row is
// NO_PROJECTS, and the Assistant's field rows are left out with the field).
// Not imported by the app (tests and typecheck only).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { LinkController } from '../link/controller';
import type { FeatureOf, FeatureType, SketchDimensionKind, SketchEntity, SketchRelationKind } from '../types/doc';
import type { DocService } from '../types/doc-service';
import type { SketchToolId } from '../types/sketch';
import type { SKETCH_ENTITY_KINDS } from './schemas';

type SketchEntityKindIn = (typeof SKETCH_ENTITY_KINDS)[number];
import type { ViewportHandle } from '../types/viewport';
import type { UiController } from '../ui/controller';
import type { Rails } from '../ui/left-rails';
import type { ToolbarPrefs } from '../ui/toolbar-layout';
import type { Keybinds } from '../app/keybinds';
import type { CheckControl } from '../features/check/controls';
import type { SectionControl } from '../features/section/controls';

export type Reach =
  | { kind: 'reach'; tool: string; field: string; value?: string; note?: string; projects?: true; without?: string }
  | { kind: 'auto'; why: string };

export const reach = (tool: string, field: string, value?: string, note?: string): Reach => ({ kind: 'reach', tool, field, ...(value !== undefined ? { value } : {}), ...(note ? { note } : {}) });
export const auto = (why: string): Reach => ({ kind: 'auto', why });
/**
 * Reached only where the host has projects (Magnusim); Magnusim CAD has neither the control nor the
 * field (`without`: why, where NO_PROJECTS does not say it).
 */
const inProjects = (r: Reach, without?: string): Reach => (r.kind === 'reach' ? { ...r, projects: true, ...(without ? { without } : {}) } : r);
/** A project-only row where the host has no projects (Magnusim CAD, projectLinks false). */
export const NO_PROJECTS = auto('not in Magnusim CAD: with no projects there is no simulation, so neither the person nor the Assistant has it there');
/** An Enclosure's input where the host has no projects: Magnusim CAD keeps an Enclosure made in Magnusim as it is. */
export const ENCLOSURE_KEPT_WHY =
  "not in Magnusim CAD: it has no Enclosure command, and an Enclosure made in Magnusim stays as it is there (its panel shows it read-only, edit_feature refuses its values), so neither the person nor the Assistant changes it";
const KEPT = (r: Reach) => inProjects(r, ENCLOSURE_KEPT_WHY);

const W = (action: string) => reach('workspace', 'action', action);
/** See-through bodies (INSPECT > See-through, the body's menu): workspace see_through, and opaque the other way. */
const SEE = reach('workspace', 'action', 'see_through', 'action opaque makes them opaque again');
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
/** Paste (Ctrl+V) brings in what the person copied, from this Part or another: the copy row's "from clipboard" does, and get_model says what is held. */
const PASTE = reach('sketch', 'constraints[].kind', 'copy', 'value "from clipboard" pastes what the person copied (Ctrl+C in a sketch of any Part); get_model\'s clipboard says what is held');
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
  'view.iso_back': W('standard_view'),
  'view.normal-to': W('normal_to'),
  'modify.parameters': reach('set_params', 'set'),
  'modify.chamfer': MODIFY('chamfer'),
  'modify.fillet': MODIFY('fillet'),
  'modify.shell': MODIFY('shell'),
  'modify.combine': reach('combine', 'op'),
  'modify.delete-faces': DIRECT('delete_faces'),
  'modify.press-pull': DIRECT('press_pull'),
  'modify.split': DIRECT('split'),
  'modify.move-body': DIRECT('move_body'),
  'inspect.check': reach('measure', 'targets'),
  'inspect.mass': reach('measure', 'targets'),
  'inspect.measure': reach('measure', 'targets'),
  'inspect.section': W('section'),
  'inspect.see-through': SEE,
  'cfd.enclosure': inProjects(DIRECT('enclosure')),
  'file.export-step': W('export_step'),
  'file.import-step': W('import_step'),
  'solid.extrude': reach('extrude', 'extent'),
  'solid.revolve': reach('revolve', 'axis'),
  'solid.sweep': reach('sweep_loft', 'kind', 'sweep'),
  'solid.loft': reach('sweep_loft', 'kind', 'loft'),
  'solid.hole': reach('hole', 'face'),
  'inspect.find': reach('find', 'query'),
  'file.picture': reach('view', 'views'),
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
  'sketch.import': SKETCH_OP('import'),
  // Copy and Paste: the sketch tool's copy row (this sketch's items, another sketch's of this Part
  // with "from <sketch>", or what the person copied in any Part with "from clipboard").
  'sketch.copy': SKETCH_OP('copy'),
  'sketch.paste': PASTE,
  'sketch.spline': ENTITY('spline'),
  'sketch.spline-control': ENTITY('control_spline'),
  // The Ellipse group.
  'sketch.ellipse': ENTITY('ellipse'),
  'sketch.ellipse-partial': ENTITY('ellipse_arc'),
  'sketch.parabola': ENTITY('parabola'),
  'sketch.conic': ENTITY('conic'),
  'sketch.mirror': SKETCH_OP('mirror'),
  'sketch.pattern-linear': SKETCH_OP('linear_pattern'),
  'sketch.pattern-circular': SKETCH_OP('circular_pattern'),
  'sketch.offset': SKETCH_OP('offset'),
  'sketch.fillet': SKETCH_OP('fillet'),
  'sketch.chamfer': SKETCH_OP('chamfer'),
  'sketch.enter': auto("Enter places a point or finishes the tool in use: a pointer step of the person's"),
  'sketch.curve-pick': auto("a pick of the person's for Project and Intersect (sketch.project, sketch.intersect)"),
  // v0.5.0 (SHAPES): the shape tools draw the Assistant's macros.
  'sketch.line-midpoint': ENTITY('midpoint_line'),
  'sketch.rectangle-3pt': ENTITY('rect_3pt'),
  'sketch.rectangle-center-3pt': ENTITY('center_rect_3pt'),
  'sketch.parallelogram': ENTITY('parallelogram'),
  'sketch.circle-3pt': ENTITY('circle_3pt'),
  'sketch.arc-center': ENTITY('arc'),
  'sketch.slot': ENTITY('slot'),
  'sketch.slot-overall': ENTITY('slot'),
  'sketch.slot-center-point': ENTITY('slot'),
  'sketch.slot-arc-3pt': ENTITY('arc_slot'),
  'sketch.slot-arc-center': ENTITY('arc_slot'),
  'sketch.polygon': ENTITY('polygon'),
  'sketch.sector': ENTITY('sector'),
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
  delete_faces: {
    ...BASE,
    body: DIRECT_FIELD('faces'),
    // The panel's Add by size and its box select are the person's ways to the same faces (features/delete_faces/by-size.ts runs these selectors).
    faces: reach('direct', 'faces', undefined, 'also the panel\'s Fillets up to / Holes up to Add (= "<body> faces fillet <= R" / "<body> faces hole <= D") and a Ctrl+drag box while the panel is open'),
    repair: REPAIR,
    version: auto('the build version a saved Delete faces keeps (2: fillets may come off as fillets where the heal is refused)'),
  },
  press_pull: { ...BASE, body: DIRECT_FIELD('faces'), faces: DIRECT_FIELD('faces'), distance: DIRECT_FIELD('distance'), repair: REPAIR, version: auto('the build version a saved press-pull keeps') },
  split: { ...BASE, targets: DIRECT_FIELD('bodies'), tool: DIRECT_FIELD('tool'), repair: REPAIR },
  delete_body: { ...BASE, bodies: DIRECT_FIELD('bodies') },
  move_body: {
    ...BASE,
    bodies: DIRECT_FIELD('bodies'),
    move: DIRECT_FIELD('move'),
    angle: DIRECT_FIELD('turn.angle'),
    about: DIRECT_FIELD('turn.axis'),
    axis: DIRECT_FIELD('turn.axis'),
    pivot: DIRECT_FIELD('turn.pivot'),
    copy: DIRECT_FIELD('copy'),
  },
  // Magnusim CAD keeps an Enclosure made in Magnusim as it is (KEPT): name and suppression as any feature's.
  enclosure: {
    ...BASE,
    shape: KEPT(DIRECT_FIELD('shape')),
    axis: KEPT(reach('direct', 'shape', 'cylinder_z')),
    bodies: KEPT(DIRECT_FIELD('bodies')),
    padding: KEPT(DIRECT_FIELD('padding')),
    percent: KEPT(DIRECT_FIELD('distance')),
    distance: KEPT(DIRECT_FIELD('distance')),
    sides: KEPT(DIRECT_FIELD('sides')),
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
  ellipse: ENTITY('ellipse'),
  ellipse_arc: ENTITY('ellipse_arc'),
  parabola: ENTITY('parabola'),
  conic: ENTITY('conic'),
};

// The person's relations palette by the selection (src/sketch/relations-palette.ts) adds through the
// CONSTRAIN commands, so it offers no kind beyond these rows; its Symmetric of two lines or two
// circles about a centerline is point Symmetric records (and an On line for a shared end), which
// the tool writes with its symmetric and point_on rows.
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
  'line-midpoint': ENTITY('midpoint_line'),
  'rectangle-3pt': ENTITY('rect_3pt'),
  'rectangle-center-3pt': ENTITY('center_rect_3pt'),
  parallelogram: ENTITY('parallelogram'),
  'circle-3pt': ENTITY('circle_3pt'),
  'arc-center': ENTITY('arc'),
  'slot-center': ENTITY('slot'),
  'slot-overall': ENTITY('slot'),
  'slot-center-point': ENTITY('slot'),
  'slot-arc-3pt': ENTITY('arc_slot'),
  'slot-arc-center': ENTITY('arc_slot'),
  polygon: ENTITY('polygon'),
  sector: ENTITY('sector'),
  intersect: SKETCH_OP('intersect'),
  import: SKETCH_OP('import'),
  paste: PASTE,
  ellipse: ENTITY('ellipse'),
  'ellipse-partial': ENTITY('ellipse_arc'),
  parabola: ENTITY('parabola'),
  conic: ENTITY('conic'),
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
  moveFeature: reach('edit_feature', 'move'),
  setBodyColor: reach('body', 'color'),
  pickBodyColor: reach('body', 'color'),
  deleteFeatures: reach('delete', 'features'),
  runFeatureAction: REPAIR,
  deleteFeature: reach('delete', 'features'),
  rollBackTo: W('roll_back_to'),
  rollToEnd: W('roll_to_end'),
  setRollbackIndex: W('roll_back_to'),
  setBodyVisible: reach('body', 'visibility'),
  setBodiesSeeThrough: SEE,
  setFeatureVisible: W('show'),
  setBodyInSimulation: inProjects(reach('body', 'simulation')),
  deleteBodies: DIRECT('delete_body'),
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
  joinSteps: reach('delete', 'features'),
  renameBody: reach('body', 'rename_to'),
  setBodyColor: reach('body', 'color'),
  setBodyInSimulation: inProjects(reach('body', 'simulation')),
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
  setBodiesSeeThrough: SEE,
  setExpanded: W('expand'),
  setPlanes: W('origin_planes'),
  setCamera: auto('the view keeps its camera by itself'),
  setSection: W('section'),
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
  bodiesAtEnd: inProjects(W('send_to_simulation')),
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
  // v0.5.0 ribbon: the line at a group's right, and the toolbar's bottom edge.
  setWidth: W('toolbar_width'),
  setRows: W('toolbar_rows'),
  reset: W('toolbar_reset'),
  saved: INTERNAL,
};

/**
 * Daniel (2026-10-27): "the AI can have access to keybinds but can not change them unless the user
 * explicitly asks them to change them": a change needs person_asked true and the person's Yes in
 * the app's confirm dialog, every time.
 */
export const KEYBIND_CHANGE_RULE = "only when the person explicitly asked (person_asked true) and confirms in the app's dialog";
const KEYS_READ = W('keybind_get');
const KEYS = (action: string) => reach('workspace', 'action', action, KEYBIND_CHANGE_RULE);

/**
 * The person's keybinds (src/app/keybinds.ts): the Set keybind dialog (a right-click on a command:
 * the views menu now, the toolbar's menu when the ribbon lands; the test handle) and the app's
 * Settings call these.
 */
export const KEYBINDS: { readonly [K in keyof Keybinds]: Reach } = {
  ready: INTERNAL,
  load: INTERNAL,
  known: INTERNAL,
  entries: KEYS_READ,
  entry: KEYS_READ,
  current: KEYS_READ,
  keys: KEYS_READ,
  defaults: KEYS_READ,
  isDefault: KEYS_READ,
  display: KEYS_READ,
  capture: auto("the person's key press in the dialog: the Assistant names the keys in keybind_set's value"),
  problem: W('keybind_set'),
  assistantKeys: KEYS_READ,
  appClashes: KEYS_READ,
  shown: KEYS_READ,
  via: KEYS_READ,
  owners: KEYS_READ,
  conflictsWith: KEYS_READ,
  setKeybind: KEYS('keybind_set'),
  replace: KEYS('keybind_set'),
  resetToDefault: KEYS('keybind_reset'),
  clear: KEYS('keybind_clear'),
  resetAll: KEYS('keybind_reset'),
  overrides: KEYS_READ,
  conflicts: KEYS_READ,
  flush: INTERNAL,
  subscribe: INTERNAL,
  dispose: INTERNAL,
};

export const LINK: { readonly [K in keyof LinkController]: Reach } = {
  sync: inProjects(W('send_to_simulation')),
  running: INTERNAL,
  last: inProjects(W('send_to_simulation')),
};

/**
 * INSPECT's Check panel, control by control (the command inspect.check opens it). Solids is the
 * kernel's check of each body, which measure gives the Assistant per body (valid, its problems);
 * the other three modes are the check tool's kinds, on the same engine with the same words.
 */
export const CHECK: { readonly [K in CheckControl]: Reach } = {
  solids: reach('measure', 'targets'),
  interference: reach('check', 'kind', 'interference'),
  bodies: reach('check', 'bodies'),
  clearance: reach('check', 'clearance'),
  stack: reach('check', 'kind', 'stack'),
  play: reach('check', 'clearance', undefined, 'with kind stack, clearance is the play'),
  sweep: reach('check', 'kind', 'sweep'),
  turning: reach('check', 'bodies', undefined, 'with kind sweep, bodies are the ones that turn'),
  axis: reach('check', 'axis'),
  stop: auto("a check that runs stops with its call: the person's Stop on the Assistant's turn ends it"),
  row: W('select'),
};

/**
 * INSPECT's Section view panel, control by control (the command inspect.section opens it), and its
 * arrow in the view: the workspace tool's section sets the same view state (src/features/section/bind.ts
 * setSectionView), with the same plane forms (an origin plane, a construction plane by name, a flat
 * face, "selection"), offset or middle, and flip; off turns it off. What the panel's note says,
 * get_model's section says too.
 */
export const SECTION: { readonly [K in SectionControl]: Reach } = {
  on: reach('workspace', 'action', 'section', 'value "off" turns it off; any plane turns it on'),
  plane: reach('workspace', 'action', 'section', 'value "<construction plane name | flat face selector | selection> ..."'),
  origin: reach('workspace', 'action', 'section', 'value "Top|Front|Right ..."'),
  offset: reach('workspace', 'action', 'section', 'value "<plane> offset <length>"'),
  middle: reach('workspace', 'action', 'section', 'value "<plane> middle"'),
  flip: reach('workspace', 'action', 'section', 'value "<plane> ... flip"'),
  arrow: reach('workspace', 'action', 'section', 'a drag of the arrow sets the offset, as value "<plane> offset <length>" does'),
  note: reach('get_model', 'detail', 'brief', "section.note: the panel's note (on: false when the section turned off); the workspace's view.section too"),
};

const POINTER = auto("the person's pointer in the view (orbit, pick, hover): the Assistant names things by selector");
/** The view's colours follow the host's appearance (its Settings): nobody sets them in the Part, and every picture is light. */
const APPEARANCE = auto("the host's appearance (the app's Settings): the view follows it, and every picture is light whatever it is");

export const VIEWPORT: { readonly [K in keyof ViewportHandle]-?: Reach } = {
  state: reach('workspace', 'action', 'display'),
  setBodies: INTERNAL,
  setVisibility: reach('body', 'visibility'),
  setVertices: INTERNAL,
  // Move/copy body's handle draws the bodies where a drag takes them: the Assistant sets the same fields.
  previewMotion: reach('direct', 'move', undefined, "the preview of a drag of Move/copy body's handle; the drag sets move and turn as the Assistant does"),
  drawnBox: INTERNAL,
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
  palette: APPEARANCE,
  setPalette: APPEARANCE,
  lightSurfaceAt: POINTER,
  measure: INTERNAL,
  addLayer: INTERNAL,
  reframe: W('fit'),
  refitIfOffScreen: W('fit'),
  offView: INTERNAL,
  pushTool: POINTER,
  rayAt: POINTER,
  toPlane: POINTER,
  pixelSize: INTERNAL,
  onFrame: INTERNAL,
  lineResolution: INTERNAL,
  dispose: INTERNAL,
};

// ------------------------------------------------------------------ the other way: AI -> person

/**
 * The reverse direction (Daniel: parity both ways): every entity kind the Assistant's sketch tool
 * draws (schemas.ts SKETCH_ENTITY_KINDS) and the person's sketch tool that draws the same record
 * (exhaustive at typecheck: a new kind fails until a person's tool is named). A chained Line is a
 * polyline; Centerline a centerline.
 */
export const PERSON_SKETCH_KINDS: { readonly [K in SketchEntityKindIn]: SketchToolId } = {
  point: 'point',
  line: 'line',
  centerline: 'centerline',
  polyline: 'line',
  midpoint_line: 'line-midpoint',
  circle: 'circle',
  circle_3pt: 'circle-3pt',
  arc: 'arc-center',
  rect: 'rectangle-corner',
  center_rect: 'rectangle-center',
  rect_3pt: 'rectangle-3pt',
  center_rect_3pt: 'rectangle-center-3pt',
  parallelogram: 'parallelogram',
  slot: 'slot-center',
  arc_slot: 'slot-arc-center',
  polygon: 'polygon',
  sector: 'sector',
  spline: 'spline-fit',
  control_spline: 'spline-control',
  ellipse: 'ellipse',
  ellipse_arc: 'ellipse-partial',
  parabola: 'parabola',
  conic: 'conic',
};

/**
 * The Assistant's sketch entity kinds the person cannot draw: no tool named, or its tool is not a
 * registered command's (`personTools`: the sketch tools the registry's commands select), or the
 * tool's own parity row does not reach that kind (a polyline is the Line tool's chain).
 */
export function sketchKindsWithoutPersonTool(kinds: readonly string[], personTools: ReadonlySet<string>): string[] {
  const table = PERSON_SKETCH_KINDS as Readonly<Record<string, SketchToolId | undefined>>;
  const chain: Readonly<Record<string, string>> = { polyline: 'line' };
  return kinds.filter((k) => {
    const tool = table[k];
    if (!tool || !personTools.has(tool)) return true;
    const row = SKETCH_TOOLS[tool];
    return !(row.kind === 'reach' && row.tool === 'sketch' && row.field === 'entities[].kind' && (row.value === k || row.value === chain[k]));
  });
}

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
  keybinds: KEYBINDS,
  link: LINK,
  viewport: VIEWPORT,
  check: CHECK,
  section: SECTION,
};

// ------------------------------------------------------------------ the other way: every Assistant tool's field, the person's path

/**
 * How the person does what an Assistant tool's field or enum value does:
 *   command(id)              a registered command (the toolbar, a context menu or a key runs it);
 *   control(table, method)   a method of the person's controls (the tables above: the tree, the
 *                            panels, the document, the view, the toolbar, Back's link);
 *   panel(type, field)       a field of a feature type's own panel (its record's field);
 *   place(where)             a control of the person's no table holds (a chip's Retry, the Part row's
 *                            rename, drawing in sketch mode): where it is, in words;
 *   own(why)                 not a person's action: the Assistant's own plumbing (its ids, a
 *                            reference text, "keep this as it is").
 */
export type PersonPath = (
  | { kind: 'command'; id: string }
  | { kind: 'control'; table: ControlTable; method: string }
  | { kind: 'panel'; type: FeatureType; field: string }
  | { kind: 'place'; where: string }
  | { kind: 'own'; why: string }
) & {
  /** The Assistant's field is offered only where the host has projects (Magnusim): left out in Magnusim CAD. */
  projects?: true;
  /** Another way the person has to set the same field, in words (a drag handle in the view). */
  also?: string;
};

export type ControlTable = 'ui' | 'doc' | 'rails' | 'toolbar' | 'keybinds' | 'link' | 'viewport' | 'check' | 'section';

export const command = (id: string): PersonPath => ({ kind: 'command', id });
export const control = (table: ControlTable, method: string): PersonPath => ({ kind: 'control', table, method });
export const panel = (type: FeatureType, field: string): PersonPath => ({ kind: 'panel', type, field });
export const place = (where: string): PersonPath => ({ kind: 'place', where });
export const own = (why: string): PersonPath => ({ kind: 'own', why });

const EDIT_ROW = control('ui', 'openEdit');
const NAME_ROW = control('ui', 'renameFeature');
const KEEP = own('"keep": leave it as it is');
const IDS = own("the Assistant's own ids for its rows (the person points at what they mean)");
const PARAMS = command('modify.parameters');
const PICTURE = command('file.picture');
const HOLE = command('solid.hole');
const MEASURE = command('inspect.measure');
const DIMENSION = command('sketch.dimension');
const REFERENCE = own("reference text for the model; the person has the program's documentation");
const OPS = (type: FeatureType) => ({ 'op=new': panel(type, 'op'), 'op=join': panel(type, 'op'), 'op=cut': panel(type, 'op'), 'op=intersect': panel(type, 'op') });
const NEW_BODY = { body_name: control('ui', 'renameBody'), color: control('ui', 'setBodyColor') };
const each = (values: readonly string[], prefix: string, path: PersonPath) => Object.fromEntries(values.map((v) => [`${prefix}=${v}`, path]));
/** Move/copy body's handle in the view (src/features/move_body/handle.ts): its arrows set Move X, Y, Z; its rings the Angle and About. */
const MOVE_ARROWS = "the arrows of Move/copy body's handle in the view: a drag sets Move X, Y or Z";
const MOVE_RINGS = "the rings of Move/copy body's handle in the view: a drag sets the Angle about X, Y, Z or the picked axis";
/** An Assistant field only a host with projects offers (Magnusim; not Magnusim CAD). */
const onlyInProjects = (p: PersonPath): PersonPath => ({ ...p, projects: true });

/** Every Assistant tool's fields and enum values (schemas.ts), and the person's path to each. */
export const AI_TOOLS: Readonly<Record<string, Readonly<Record<string, PersonPath>>>> = {
  get_model: {
    'detail=brief': place("the design tree: every feature with its state badge and message, the bodies, the sketches' (-)/(+) and the DOF chip"),
    'detail=full': EDIT_ROW,
    feature: EDIT_ROW,
    'regions=short': own("how much of a sketch's region list the model is sent"),
    'regions=full': place('the view in model mode: hovering a sketch region lights it, a click selects it'),
  },
  find: { query: command('inspect.find'), limit: own('how many rows the model is sent; the Find panel lists them all') },
  measure: { targets: MEASURE, section: MEASURE },
  view: {
    ...each(['iso', 'iso_back', 'front', 'back', 'left', 'right', 'top', 'bottom'], 'views', PICTURE),
    hide: PICTURE,
    section: PICTURE,
    ...each(['none', 'bodies', 'faces'], 'labels', PICTURE),
    ...each(['small', 'large'], 'size', PICTURE),
    ...each(['shaded_edges', 'shaded', 'wireframe'], 'display', PICTURE),
    ...each(['orthographic', 'perspective'], 'projection', PICTURE),
    // The person looks straight at a sketch with Normal to (its row selected, N); the Picture panel has no sketch choice.
    sketch: command('view.normal-to'),
  },
  help: each(['sketch', 'selectors', 'features', 'parameters', 'checks', 'traps', 'errors', 'examples', 'example_plate', 'example_bracket', 'example_flange', 'example_chip', 'guide', 'sketch_tools', 'details', 'workspace', 'assemblies', 'printing'], 'topic', REFERENCE),
  // The assembly checks (src/features/assembly/check.ts): INSPECT's Check panel runs the same engine
  // and shows the same words, in its Interference, Loose parts and Rotation modes.
  check: {
    'kind=interference': control('check', 'interference'),
    'kind=stack': control('check', 'stack'),
    'kind=sweep': control('check', 'sweep'),
    // The bodies checked (selected ones), or with sweep the ones that turn (Rotation's Turning).
    bodies: control('check', 'bodies'),
    // Interference's Clearance; with stack, Loose parts' Play.
    clearance: control('check', 'clearance'),
    axis: control('check', 'axis'),
  },
  set_params: {
    'set[].name': PARAMS,
    ...each(['length', 'angle', 'number'], 'set[].kind', PARAMS),
    'set[].expr': PARAMS,
    'set[].comment': PARAMS,
    'set[].rename_to': PARAMS,
    remove: PARAMS,
  },
  sketch: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    on: command('sketch.new'),
    'entities[].id': IDS,
    // Each kind's command is the one whose sketch tool PERSON_SKETCH_KINDS names (the test holds them together).
    'entities[].kind=point': command('sketch.point'),
    'entities[].kind=line': command('sketch.line'),
    'entities[].kind=centerline': command('sketch.centerline'),
    'entities[].kind=polyline': command('sketch.line'),
    'entities[].kind=midpoint_line': command('sketch.line-midpoint'),
    'entities[].kind=circle': command('sketch.circle'),
    'entities[].kind=circle_3pt': command('sketch.circle-3pt'),
    'entities[].kind=arc': command('sketch.arc-center'),
    'entities[].kind=rect': command('sketch.rectangle'),
    'entities[].kind=center_rect': command('sketch.rectangle-center'),
    'entities[].kind=rect_3pt': command('sketch.rectangle-3pt'),
    'entities[].kind=center_rect_3pt': command('sketch.rectangle-center-3pt'),
    'entities[].kind=parallelogram': command('sketch.parallelogram'),
    'entities[].kind=slot': command('sketch.slot'),
    'entities[].kind=arc_slot': command('sketch.slot-arc-center'),
    'entities[].kind=polygon': command('sketch.polygon'),
    'entities[].kind=sector': command('sketch.sector'),
    'entities[].kind=spline': command('sketch.spline'),
    'entities[].kind=control_spline': command('sketch.spline-control'),
    'entities[].kind=ellipse': command('sketch.ellipse'),
    'entities[].kind=ellipse_arc': command('sketch.ellipse-partial'),
    'entities[].kind=parabola': command('sketch.parabola'),
    'entities[].kind=conic': command('sketch.conic'),
    'entities[].at': place('where the person clicks in sketch mode, and the dimensions they set'),
    'entities[].construction': command('sketch.construction'),
    'constraints[].id': IDS,
    'constraints[].kind=coincident': command('sketch.coincident'),
    'constraints[].kind=horizontal': command('sketch.horizontal'),
    'constraints[].kind=vertical': command('sketch.vertical'),
    'constraints[].kind=parallel': command('sketch.parallel'),
    'constraints[].kind=perpendicular': command('sketch.perpendicular'),
    'constraints[].kind=tangent': command('sketch.tangent'),
    'constraints[].kind=equal': command('sketch.equal'),
    'constraints[].kind=midpoint': command('sketch.midpoint'),
    'constraints[].kind=symmetric': command('sketch.symmetric'),
    'constraints[].kind=point_on': command('sketch.coincident'),
    'constraints[].kind=concentric': command('sketch.concentric'),
    'constraints[].kind=collinear': command('sketch.collinear'),
    ...each(['distance', 'distance_x', 'distance_y', 'radius', 'diameter', 'angle'], 'constraints[].kind', DIMENSION),
    'constraints[].kind=fix': command('sketch.fix'),
    'constraints[].kind=trim': command('sketch.trim'),
    'constraints[].kind=extend': command('sketch.extend'),
    'constraints[].kind=offset': command('sketch.offset'),
    'constraints[].kind=fillet': command('sketch.fillet'),
    'constraints[].kind=chamfer': command('sketch.chamfer'),
    'constraints[].kind=mirror': command('sketch.mirror'),
    'constraints[].kind=linear_pattern': command('sketch.pattern-linear'),
    'constraints[].kind=circular_pattern': command('sketch.pattern-circular'),
    'constraints[].kind=project': command('sketch.project'),
    'constraints[].kind=intersect': command('sketch.intersect'),
    'constraints[].kind=import': command('sketch.import'),
    // Copy (Ctrl+C) in one sketch, Paste (Ctrl+V) in this one or another (of any Part): the same clip
    // ("from <sketch>" is a sketch of this Part; "from clipboard" is what the person copied).
    'constraints[].kind=copy': command('sketch.paste'),
    'constraints[].kind=break_link': place("a linked curve's context menu in sketch mode: Break link"),
    'constraints[].refs': place('the curves and points the person picks for the relation, dimension or tool'),
    'constraints[].value': DIMENSION,
    infer: place('sketch mode adds horizontal and vertical by itself as the person draws along them'),
  },
  extrude: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    sketch: panel('extrude', 'profiles'),
    regions: panel('extrude', 'profiles'),
    face: panel('extrude', 'face'),
    direction: panel('extrude', 'direction'),
    ...each(['blind', 'symmetric', 'two', 'through', 'through_both', 'to'], 'extent', panel('extrude', 'extent')),
    distance: panel('extrude', 'extent'),
    distance2: panel('extrude', 'extent'),
    to: panel('extrude', 'extent'),
    flip: panel('extrude', 'flip'),
    ...OPS('extrude'),
    bodies: panel('extrude', 'scope'),
    ...NEW_BODY,
  },
  revolve: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    sketch: panel('revolve', 'profiles'),
    regions: panel('revolve', 'profiles'),
    axis: panel('revolve', 'axis'),
    ...each(['full', 'one', 'symmetric', 'two'], 'extent', panel('revolve', 'extent')),
    angle: panel('revolve', 'extent'),
    angle2: panel('revolve', 'extent'),
    flip: panel('revolve', 'flip'),
    ...OPS('revolve'),
    bodies: panel('revolve', 'scope'),
    ...NEW_BODY,
  },
  sweep_loft: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    'kind=sweep': command('solid.sweep'),
    'kind=loft': command('solid.loft'),
    profiles: panel('loft', 'sections'),
    path: panel('sweep', 'path'),
    ...each(['follow', 'fixed'], 'orientation', panel('sweep', 'orientation')),
    ruled: panel('loft', 'ruled'),
    ...OPS('sweep'),
    bodies: panel('sweep', 'scope'),
    ...NEW_BODY,
  },
  modify: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    'kind=fillet': command('modify.fillet'),
    'kind=chamfer': command('modify.chamfer'),
    'kind=shell': command('modify.shell'),
    targets: panel('fillet', 'edges'),
    size: panel('fillet', 'radius'),
    size2: panel('chamfer', 'distance2'),
    flip: panel('chamfer', 'flip'),
    inward: panel('shell', 'direction'),
  },
  pattern: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    'kind=linear': command('pattern.linear'),
    'kind=circular': command('pattern.circular'),
    'kind=mirror': command('pattern.mirror'),
    ...each(['features', 'bodies', 'faces'], 'of', panel('pattern_linear', 'of')),
    items: panel('pattern_linear', 'features'),
    about: panel('pattern_linear', 'dir1'),
    count: panel('pattern_linear', 'dir1'),
    spacing: panel('pattern_linear', 'dir1'),
    flip: panel('pattern_linear', 'dir1'),
    about2: panel('pattern_linear', 'dir2'),
    count2: panel('pattern_linear', 'dir2'),
    spacing2: panel('pattern_linear', 'dir2'),
    'options=symmetric': panel('pattern_circular', 'symmetric'),
    'options=flip2': panel('pattern_linear', 'dir2'),
    'options=symmetric2': panel('pattern_linear', 'dir2'),
    'options=extent': panel('pattern_linear', 'dir1'),
    'options=extent2': panel('pattern_linear', 'dir2'),
    skip: panel('pattern_linear', 'skip'),
    'op=source': panel('pattern_linear', 'op'),
    ...OPS('pattern_linear'),
    bodies: panel('pattern_linear', 'scope'),
  },
  combine: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    ...each(['join', 'cut', 'intersect'], 'op', panel('combine', 'op')),
    targets: panel('combine', 'targets'),
    tools: panel('combine', 'tools'),
    keep_tools: panel('combine', 'keepTools'),
  },
  body: {
    body: place("the body's row in the tree (Bodies)"),
    rename_to: control('ui', 'renameBody'),
    color: control('ui', 'setBodyColor'),
    'simulation=keep': onlyInProjects(KEEP),
    'simulation=include': onlyInProjects(control('ui', 'setBodyInSimulation')),
    'simulation=exclude': onlyInProjects(control('ui', 'setBodyInSimulation')),
    'visibility=keep': KEEP,
    'visibility=show': control('ui', 'setBodyVisible'),
    'visibility=hide': control('ui', 'setBodyVisible'),
  },
  edit_feature: {
    feature: EDIT_ROW,
    'set[].field': EDIT_ROW,
    'set[].value': EDIT_ROW,
    rename_to: NAME_ROW,
    'suppress=keep': KEEP,
    'suppress=suppress': control('ui', 'toggleSuppressed'),
    'suppress=unsuppress': control('ui', 'toggleSuppressed'),
    move: control('ui', 'moveFeature'),
  },
  // Undo of a whole Assistant request: the request is one undo step of the Part, so the person's
  // Ctrl+Z takes it all back (an Undo of a request in the Assistant dock is the dock's own).
  undo: {
    'action=own': control('doc', 'undo'),
    'action=undo': control('doc', 'undo'),
    'action=redo': control('doc', 'redo'),
    steps: control('doc', 'undo'),
    previous_turn: control('doc', 'undo'),
  },
  delete: { features: control('ui', 'deleteFeatures') },
  construct: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    ...each(['offset', 'angle', 'three_points', 'midplane', 'normal_to_curve'], 'method', command('construct.plane')),
    ...each(['two_points', 'cylinder', 'edge', 'two_planes'], 'method', command('construct.axis')),
    ...each(['vertex', 'center', 'on_edge', 'edge_plane', 'coordinates'], 'method', command('construct.point')),
    refs: panel('ref_plane', 'plane'),
    value: panel('ref_plane', 'distance'),
    xyz: panel('ref_point', 'xyz'),
    flip: panel('ref_plane', 'flip'),
    from_end: panel('ref_point', 'fromEnd'),
  },
  direct: {
    edit: EDIT_ROW,
    name: NAME_ROW,
    'kind=press_pull': command('modify.press-pull'),
    'kind=delete_faces': command('modify.delete-faces'),
    'kind=split': command('modify.split'),
    'kind=enclosure': onlyInProjects(command('cfd.enclosure')),
    'kind=delete_body': control('ui', 'deleteBodies'),
    'kind=move_body': command('modify.move-body'),
    'kind=repair': control('ui', 'runFeatureAction'),
    'kind=retry': control('ui', 'runFeatureAction'),
    faces: panel('press_pull', 'faces'),
    distance: panel('press_pull', 'distance'),
    bodies: panel('split', 'targets'),
    tool: panel('split', 'tool'),
    keep_tool: panel('split', 'tool'),
    move: { ...panel('move_body', 'move'), also: MOVE_ARROWS },
    'turn.angle': { ...panel('move_body', 'angle'), also: MOVE_RINGS },
    'turn.axis': { ...panel('move_body', 'axis'), also: MOVE_RINGS },
    'turn.pivot': panel('move_body', 'pivot'),
    copy: panel('move_body', 'copy'),
    // The Enclosure's kind and fields: Magnusim's alone (Magnusim CAD has no Enclosure command).
    'shape=box': onlyInProjects(panel('enclosure', 'shape')),
    ...each(['cylinder_x', 'cylinder_y', 'cylinder_z'], 'shape', onlyInProjects(panel('enclosure', 'axis'))),
    ...each(['zero', 'percent', 'fixed'], 'padding', onlyInProjects(panel('enclosure', 'padding'))),
    ...each(['+x', '-x', '+y', '-y', '+z', '-z', 'radius', 'top', 'bottom'], 'sides[].side', onlyInProjects(panel('enclosure', 'sides'))),
    'sides[].value': onlyInProjects(panel('enclosure', 'sides')),
  },
  hole: {
    name: HOLE,
    face: HOLE,
    'centers[].x': HOLE,
    'centers[].y': HOLE,
    'centers[].z': HOLE,
    diameter: HOLE,
    ...each(['through', 'blind'], 'depth', HOLE),
    distance: HOLE,
  },
  workspace: {
    'action=roll_back_to': control('ui', 'rollBackTo'),
    'action=roll_to_end': control('ui', 'rollToEnd'),
    'action=show': control('ui', 'setFeatureVisible'),
    'action=hide': control('ui', 'setFeatureVisible'),
    // INSPECT > See-through on the selected bodies (again: opaque), and the body's menu in the tree or the view.
    'action=see_through': { ...command('inspect.see-through'), also: "the body's menu in the tree or the view: Make <body> see-through" },
    'action=opaque': { ...command('inspect.see-through'), also: "the body's menu in the tree or the view: Make <body> opaque" },
    'action=origin_planes': control('viewport', 'setPlanes'),
    'action=rename_part': place("the tree's Part row: a double-click renames the Part"),
    'action=select': command('inspect.find'),
    'action=selection_filter': control('viewport', 'setFilter'),
    'action=expand': control('doc', 'setExpanded'),
    'action=collapse': control('rails', 'setTreeShown'),
    'action=toolbar_show': control('toolbar', 'setMode'),
    'action=toolbar_hide': control('toolbar', 'setMode'),
    'action=toolbar_move': control('toolbar', 'setMode'),
    'action=toolbar_reset': control('toolbar', 'reset'),
    'action=toolbar_width': control('toolbar', 'setWidth'),
    'action=toolbar_rows': control('toolbar', 'setRows'),
    'action=banana_show': command('scale.banana'),
    'action=banana_hide': command('scale.banana'),
    'action=banana_place': control('doc', 'setScaleModel'),
    'action=reload': control('doc', 'reload'),
    'action=keep_mine': control('doc', 'keepMine'),
    'action=retry_save': control('doc', 'retrySave'),
    'action=retry_kernel': place("the geometry kernel's chip in the status dock: Retry"),
    'action=import_step': command('file.import-step'),
    'action=reheal': panel('import', 'heal'),
    'action=export_step': command('file.export-step'),
    'action=send_to_simulation': onlyInProjects(control('link', 'sync')),
    'action=fit': command('view.fit'),
    'action=standard_view': command('view.iso_back'),
    'action=normal_to': command('view.normal-to'),
    'action=orbit_pivot': control('viewport', 'orbitAround'),
    // INSPECT > Section view (its panel; also the view tools' section button and the arrow on the cut).
    'action=section': { ...command('inspect.section'), also: "the arrow on the cut in the view: a drag sets the offset; the view tools' section button" },
    'action=projection': control('viewport', 'setProjection'),
    'action=display': control('viewport', 'setDisplay'),
    // The Set keybind dialog (a command's right-click) and Settings; the Assistant's changes need the person's ask and Yes.
    'action=keybind_get': control('keybinds', 'current'),
    'action=keybind_set': control('keybinds', 'setKeybind'),
    'action=keybind_reset': control('keybinds', 'resetToDefault'),
    'action=keybind_clear': control('keybinds', 'clear'),
    target: own("the action's target: the person points at it"),
    value: own("the action's value: the person picks it in that control"),
    items: own("the action's list: the person picks them in that control"),
    person_asked: own("whether the person asked for the view or keybind change: the person's own moves and keybinds need no asking"),
  },
};

// ------------------------------------------------------------------ where the host has no projects

/**
 * The tables as they hold on a host with projects (Magnusim: as they are) or without (Magnusim CAD,
 * bridge.projectLinks() false): there a project-only row is NO_PROJECTS (or its own why: an
 * Enclosure's inputs), and the Assistant's project-only fields (the body tool's simulation, the
 * workspace's send_to_simulation, the direct tool's enclosure kind and fields) are left out, as
 * cadToolsFor leaves them out of the tools. tests/assistant/parity-no-projects.test.ts checks Magnusim CAD both ways.
 */
export function parityFor(projectLinks: boolean): { tables: Readonly<Record<string, Readonly<Record<string, Reach>>>>; aiTools: Readonly<Record<string, Readonly<Record<string, PersonPath>>>> } {
  if (projectLinks) return { tables: PARITY_TABLES, aiTools: AI_TOOLS };
  const tables = Object.fromEntries(Object.entries(PARITY_TABLES).map(([name, t]) => [name, Object.fromEntries(Object.entries(t).map(([k, r]) => [k, r.kind === 'reach' && r.projects ? (r.without ? auto(r.without) : NO_PROJECTS) : r]))]));
  const aiTools = Object.fromEntries(Object.entries(AI_TOOLS).map(([tool, rows]) => [tool, Object.fromEntries(Object.entries(rows).filter(([, p]) => !p.projects))]));
  return { tables, aiTools };
}
