// The Part's 22 tools for the app's Assistant (CAD tools spec §3): names, titles, risks, stall
// windows, descriptions and input schemas, in the schema subset the app accepts
// (scripts/server/assistant/schema.ts): type, description, enum, properties, required,
// additionalProperties false, items, min/max lengths, values and items; never $ref, unions,
// patterns, formats, defaults, consts, titles or type lists. Every property of every object is
// required ("", [] or false when unused), so the tools spend none of the strict optional budget.
// No runtime imports (type imports only, erased): the app's host test imports this file with
// Node's type stripping (scripts/__tests__/assistant-cad-tools.test.mjs).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantObjectSchema, AssistantRisk, AssistantTool } from '@magnusim/workspace';

type S = Record<string, unknown>;

const str = (maxLength: number, description: string, minLength = 0): S => ({ type: 'string', description, maxLength, ...(minLength ? { minLength } : {}) });
const en = (values: readonly string[], description: string): S => ({ type: 'string', enum: [...values], description });
const int = (minimum: number, maximum: number, description: string): S => ({ type: 'integer', minimum, maximum, description });
const num = (description: string): S => ({ type: 'number', description });
const bool = (description: string): S => ({ type: 'boolean', description });
const arr = (items: S, minItems: number, maxItems: number, description: string): S => ({ type: 'array', items, minItems, maxItems, description });
/** Every property required: CAD tools use none of the strict optional-parameter budget. */
const obj = (properties: Record<string, S>, description?: string): S => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const EDIT = str(80, '"" makes a new one; an existing feature name replaces its inputs (send all of them).');
const NAME = str(40, '"" for the next free name; names are unique.');
const EXPR = (d: string, min = 0) => str(200, d, min);
/** A length in a list of three (X, Y, Z). */
const LEN = EXPR('A length');
const SEL = (d: string) => str(300, d);
const OP = en(['new', 'join', 'cut', 'intersect'], 'new makes a body; join, cut and intersect change bodies: cut and intersect need overlap, join overlap or a shared face.');
const BODIES = arr(str(80, 'A body name'), 0, 32, 'join, cut, intersect: the bodies; [] means every body it meets. new: [].');
const BODY_NAME = str(40, 'op new: the body name; "" for Body N.');
const COLOR = str(7, 'op new: "#rrggbb"; "" for the default.');
const REGIONS = arr(str(80, '"all", a region id ("r2") or "at(u, v)" in mm'), 1, 40, 'Regions of the sketch.');

/** The help topics (the help tool's enum and src/assistant/help.ts's keys). */
export const HELP_TOPICS = [
  'sketch',
  'selectors',
  'features',
  'parameters',
  'checks',
  'traps',
  'errors',
  'examples',
  'example_plate',
  'example_bracket',
  'example_flange',
  'example_chip',
  'guide',
  'sketch_tools',
  'details',
  'workspace',
  'assemblies',
  'printing',
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

/** The construct tool's methods (plane, then axis, then point). */
export const CONSTRUCT_METHOD_NAMES = ['offset', 'angle', 'three_points', 'midplane', 'normal_to_curve', 'two_points', 'cylinder', 'edge', 'two_planes', 'vertex', 'center', 'on_edge', 'edge_plane', 'coordinates'] as const;
const CONSTRUCT_METHODS = CONSTRUCT_METHOD_NAMES;

/** The direct tool's kinds. */
export const DIRECT_KIND_NAMES = ['press_pull', 'delete_faces', 'split', 'enclosure', 'delete_body', 'move_body', 'repair', 'retry'] as const;
const DIRECT_KINDS = DIRECT_KIND_NAMES;

/** The check tool's kinds. */
export const CHECK_KINDS = ['interference', 'stack', 'sweep'] as const;

/** The pattern tool's options (on/off choices beyond flip). */
export const PATTERN_OPTIONS = ['symmetric', 'flip2', 'symmetric2', 'extent', 'extent2'] as const;

/** The view directions (the view tool's enum). */
export const VIEW_DIRECTIONS = ['iso', 'iso_back', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;

/** The workspace tool's actions (its enum; tools/workspace.ts answers each). */
export const WORKSPACE_ACTIONS = [
  'roll_back_to',
  'roll_to_end',
  'show',
  'hide',
  'see_through',
  'opaque',
  'origin_planes',
  'rename_part',
  'select',
  'selection_filter',
  'expand',
  'collapse',
  'toolbar_show',
  'toolbar_hide',
  'toolbar_move',
  'toolbar_reset',
  'toolbar_width',
  'toolbar_rows',
  'banana_show',
  'banana_hide',
  'banana_place',
  'reload',
  'keep_mine',
  'retry_save',
  'retry_kernel',
  'import_step',
  'reheal',
  'export_step',
  'send_to_simulation',
  'fit',
  'standard_view',
  'normal_to',
  'orbit_pivot',
  'section',
  'projection',
  'display',
  'keybind_get',
  'keybind_set',
  'keybind_reset',
  'keybind_clear',
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];
/** The workspace actions where the host has no projects (Magnusim CAD): no send_to_simulation. */
const WORKSPACE_ACTIONS_WITHOUT_PROJECTS: readonly WorkspaceAction[] = Object.freeze(WORKSPACE_ACTIONS.filter((a) => a !== 'send_to_simulation'));
/** The workspace tool's actions on this host: every one where it has projects (Magnusim), none of a simulation's in Magnusim CAD. */
export function workspaceActionsFor(projectLinks: boolean): readonly WorkspaceAction[] {
  return projectLinks ? WORKSPACE_ACTIONS : WORKSPACE_ACTIONS_WITHOUT_PROJECTS;
}

/** The sketch entity kinds and relation/dimension kinds (the sketch tool's enums). */
export const SKETCH_ENTITY_KINDS = ['point', 'line', 'centerline', 'polyline', 'midpoint_line', 'circle', 'circle_3pt', 'arc', 'rect', 'center_rect', 'rect_3pt', 'center_rect_3pt', 'parallelogram', 'slot', 'arc_slot', 'polygon', 'sector', 'spline', 'control_spline', 'ellipse', 'ellipse_arc', 'parabola', 'conic'] as const;
export const SKETCH_CONSTRAINT_KINDS = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'midpoint',
  'symmetric',
  'point_on',
  'concentric',
  'collinear',
  'distance',
  'distance_x',
  'distance_y',
  'radius',
  'diameter',
  'angle',
] as const;
/** Fix and the person's sketch tools, as rows of the sketch tool's constraints (help sketch_tools). */
export const SKETCH_TOOL_KINDS = ['fix', 'trim', 'extend', 'offset', 'fillet', 'chamfer', 'mirror', 'linear_pattern', 'circular_pattern', 'project', 'intersect', 'break_link', 'import', 'copy'] as const;

interface ToolSpec {
  name: string;
  title: string;
  risk: AssistantRisk;
  timeoutS: number;
  description: string;
  schema: S;
  confirm?: string;
}

/**
 * The body tool. `simulation`: where the host has projects (Magnusim), the field that says whether
 * the body goes into the project's simulation geometry; Magnusim CAD (projectLinks false) has no
 * simulation, and the tool there neither has the field nor speaks of it.
 */
function bodySpec(simulation: boolean): ToolSpec {
  return {
    name: 'body',
    title: 'Name, colour or show a body',
    risk: 'edit',
    timeoutS: 60,
    description: `Rename a body, set its colour (#rrggbb), ${simulation ? "say whether it goes into the project's simulation geometry, " : ''}or show or hide it in the person's view (the tree's eye: saved view state, not an undo step). "" or keep leaves a field as it is. One step.`,
    schema: obj({
      body: str(80, 'The body', 1),
      rename_to: str(40, '"" keeps it'),
      color: str(7, '"#rrggbb" or ""'),
      ...(simulation ? { simulation: en(['keep', 'include', 'exclude'], 'In the simulation geometry') } : {}),
      visibility: en(['keep', 'show', 'hide'], "In the person's view"),
    }),
  };
}

/**
 * The direct tool. `enclosure`: where the host has projects (Magnusim), the Enclosure (CFD prep: a
 * box or a cylinder around the bodies) is one of its kinds; Magnusim CAD (projectLinks false) has no
 * Enclosure command, and the tool there has neither the kind nor its fields, nor speaks of them.
 */
function directSpec(enclosure: boolean): ToolSpec {
  return {
    name: 'direct',
    title: enclosure ? 'Direct edits and enclosure' : 'Direct edits',
    risk: 'edit',
    timeoutS: 240,
    description: enclosure
      ? 'Direct edits and CFD prep, as the person\'s panels do. kind press_pull: faces of one body move along their own normals by distance (above 0 adds, below 0 removes). delete_faces: faces of one body go and their neighbours grow over the gap. split: bodies split by tool: Top, Front or Right moved distance ("" for 0), the plane of a flat face, or another body (keep_tool keeps it). enclosure: a box or a cylinder about X, Y or Z (shape) around bodies ([] every solid body before it); padding zero, percent (distance "10") or fixed (distance "10 mm"); sides rows set single sides on their own (box +x, -x, +y, -y, +z, -z; cylinder radius, top, bottom). delete_body: bodies leave the model from here on. move_body: bodies turn, then move (copy: copies do). repair: the person\'s Try repair of the failed feature named in edit; retry: build again the feature in edit that the geometry kernel stopped. Fields a kind does not use: "", [], false, shape box, padding zero. A failure changes nothing.'
      : 'Direct edits, as the person\'s panels do. kind press_pull: faces of one body move along their own normals by distance (above 0 adds, below 0 removes). delete_faces: faces of one body go and their neighbours grow over the gap. split: bodies split by tool: Top, Front or Right moved distance ("" for 0), the plane of a flat face, or another body (keep_tool keeps it). delete_body: bodies leave the model from here on. move_body: bodies turn, then move (copy: copies do). repair: the person\'s Try repair of the failed feature named in edit; retry: build again the feature in edit that the geometry kernel stopped. Fields a kind does not use: "", [], false. A failure changes nothing.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      kind: en(enclosure ? DIRECT_KINDS : DIRECT_KINDS.filter((k) => k !== 'enclosure'), 'What to do'),
      faces: arr(SEL('A face selector'), 0, 60, 'press_pull, delete_faces: faces of one body; else [].'),
      distance: enclosure
        ? EXPR('press_pull: the distance; split by Top, Front, Right: the offset; enclosure percent or fixed: the padding; else ""')
        : EXPR('press_pull: the distance; split by Top, Front, Right: the offset; else ""'),
      bodies: enclosure
        ? arr(str(200, 'A body'), 0, 32, 'split, enclosure, delete_body, move_body: the bodies; else [].')
        : arr(str(200, 'A body'), 0, 32, 'split, delete_body, move_body: the bodies; else [].'),
      tool: SEL('split: Top, Front, Right, a flat face or a body; else ""'),
      keep_tool: bool('split by a body: keep the tool body'),
      move: arr(LEN, 0, 3, 'move_body: X, Y, Z; else []'),
      turn: obj({ angle: EXPR('An angle'), axis: SEL('X, Y, Z through pivot, or an axis, edge, "axis of <round face>"'), pivot: arr(LEN, 0, 3, "[] the bodies' centre") }, 'move_body: else "", "", []'),
      copy: bool('move_body: the originals stay'),
      ...(enclosure
        ? {
            shape: en(['box', 'cylinder_x', 'cylinder_y', 'cylinder_z'], 'enclosure: box or a cylinder about X, Y, Z; else box'),
            padding: en(['zero', 'percent', 'fixed'], 'enclosure: how far the sides sit out; else zero'),
            sides: arr(obj({ side: en(['+x', '-x', '+y', '-y', '+z', '-z', 'radius', 'top', 'bottom'], 'A side'), value: EXPR('A length out from the part', 1) }), 0, 9, 'enclosure: sides set on their own; else [].'),
          }
        : {}),
    }),
  };
}

/**
 * The workspace tool. `simulation`: where the host has projects (Magnusim), the action that sends the
 * Part to the project (send_to_simulation, as Back does); Magnusim CAD (projectLinks false) has no
 * simulation, and the tool there neither has the action nor speaks of it.
 */
function workspaceSpec(simulation: boolean): ToolSpec {
  return {
    name: 'workspace',
    title: 'Workspace and view',
    risk: 'edit',
    timeoutS: 180,
    description: simulation
      ? "Things the person controls around the model, one action per call (unused target, value, items: \"\" or []; help workspace has each in full). Tree: roll_back_to (target a feature), roll_to_end, show, hide (a sketch, body or construction), see_through, opaque (bodies: target or items), expand, collapse, origin_planes, select (items: selectors), selection_filter. Part and session: rename_part, reload, keep_mine, retry_save, retry_kernel, import_step (the person picks the file), reheal (an import: the one undo step here), export_step (fills in the person's Export STEP panel; they click Export), send_to_simulation (save and link, as Back does). Toolbar: toolbar_show, _hide, _move, _reset, _width, _rows. Banana: banana_show, _hide, _place. The person's view: fit, standard_view, normal_to, orbit_pivot, section, projection, display; only with person_asked true, or until they move it in this request. Keybinds: keybind_get; keybind_set, keybind_reset, keybind_clear only if the person asked (person_asked true)."
      : "Things the person controls around the model, one action per call (unused target, value, items: \"\" or []; help workspace has each in full). Tree: roll_back_to (target a feature), roll_to_end, show, hide (a sketch, body or construction), see_through, opaque (bodies: target or items), expand, collapse, origin_planes, select (items: selectors), selection_filter. Part and session: rename_part, reload, keep_mine, retry_save, retry_kernel, import_step (the person picks the file), reheal (an import: the one undo step here), export_step (fills in the person's Export STEP panel; they click Export). Toolbar: toolbar_show, _hide, _move, _reset, _width, _rows. Banana: banana_show, _hide, _place. The person's view: fit, standard_view, normal_to, orbit_pivot, section, projection, display; only with person_asked true, or until they move it in this request. Keybinds: keybind_get; keybind_set, keybind_reset, keybind_clear only if the person asked (person_asked true).",
    schema: obj({
      action: en(workspaceActionsFor(simulation), 'What to do'),
      target: str(300, 'What it acts on, or ""'),
      value: str(200, 'The value, or ""'),
      items: arr(str(300, 'A selector, name or kind'), 0, 40, 'Lists: selection, filter, export bodies; else []'),
      person_asked: bool('The person asked for this view or keybind change in this request'),
    }),
  };
}

/**
 * The edit_feature tool. `enclosure`: where the host has projects (Magnusim), its words name the
 * Enclosure's choice fields (padding, shape, axis) among the examples; Magnusim CAD keeps an Enclosure
 * made in Magnusim as it is (edit_feature refuses its values there), and the tool there names none.
 */
function editFeatureSpec(enclosure: boolean): ToolSpec {
  return {
    name: 'edit_feature',
    title: 'Change a feature',
    risk: 'edit',
    timeoutS: 180,
    description: enclosure
      ? 'Change one feature without resending everything: set expression fields by their tool field name (distance, distance2, angle, angle2, size, size2, count, spacing, count2, spacing2, or a sketch dimension\'s id), and choice or on/off fields by name with one of their words (flip "true", op "cut", method "midplane", padding "fixed", shape "cylinder", axis "Z", keepTool, orientation, ruled, along, fromEnd: get_model full lists a feature\'s values and choices); rename it (rename_to), suppress or unsuppress it, or move it in the history (move: "end", "before <feature>", "after <feature>", or "" to keep). A change that makes a working feature fail, or leaves it incomplete, changes nothing and names it. A move that breaks an order a later feature needs is refused with the reason. To Try repair or Retry a failed feature use direct.'
      : 'Change one feature without resending everything: set expression fields by their tool field name (distance, distance2, angle, angle2, size, size2, count, spacing, count2, spacing2, or a sketch dimension\'s id), and choice or on/off fields by name with one of their words (flip "true", op "cut", method "midplane", keepTool, orientation, ruled, along, fromEnd: get_model full lists a feature\'s values and choices); rename it (rename_to), suppress or unsuppress it, or move it in the history (move: "end", "before <feature>", "after <feature>", or "" to keep). A change that makes a working feature fail, or leaves it incomplete, changes nothing and names it. A move that breaks an order a later feature needs is refused with the reason. To Try repair or Retry a failed feature use direct.',
    schema: obj({
      feature: str(80, 'The feature', 1),
      set: arr(obj({ field: str(40, 'Field', 1), value: EXPR('An expression, or a choice field\'s word ("true", "false" for on/off)') }), 0, 20, 'Values to change.'),
      rename_to: str(40, '"" keeps it'),
      suppress: en(['keep', 'suppress', 'unsuppress'], 'Suppression'),
      move: str(120, '"", "end", "before X" or "after X"'),
    }),
  };
}

const SPECS: ToolSpec[] = [
  {
    name: 'get_model',
    title: 'Read the Part',
    risk: 'read',
    timeoutS: 60,
    description:
      'Read the open Part: units, parameters, every feature in history order with its state (ok, warning, error, suppressed, rolled back) and message, bodies (valid, solids, voids, volume, bounding box), parts (every body in one short row), sketches with dof and regions, the person\'s selection, what the person changed since your last call, and whether you may edit now. detail brief is small; full adds each feature\'s inputs in its own tool\'s fields, ready to resend with edit, and its expression fields for edit_feature. feature: one feature\'s name to show only it in full (a sketch: entities, constraints, solver state, regions), or "". Call it first, and after an error you do not understand, a stall or a disconnect.',
    schema: obj({
      detail: en(['brief', 'full'], 'brief: names, states, sizes. full: also every input.'),
      feature: str(80, '"" for the whole Part, or one feature name.'),
      regions: en(['short', 'full'], "One sketch's regions: short (8 rows, equal sizes summed), or full (each with its bounds and depth)."),
    }),
  },
  {
    name: 'find',
    title: 'Find faces, edges or regions',
    risk: 'read',
    timeoutS: 90,
    description:
      'Preview a selector without changing anything. Lists what it matches, with handles for later calls of this request (#f3 face, #e7 edge, #v2 vertex, #b1 body; regions as "<sketch> r2"). Each row: handle, words, label (Base.end), body, owning feature and role, type, area or length, radius, centre, normal or axis, a point on it in mm, hole or boss for cylinders, fillet_mm or hole_mm ([min, max] when it varies) and through for fillet and sized hole queries, the faces an edge joins, and for a flat face the frame a sketch on it gets. query examples: "Body 1 faces >Z", "edges of Base.end", "Plate sketch regions", "Body 1 faces hole", "Body 1 faces fillet <= 2 mm", "Body 1 faces hole <= 6 mm", "bodies". limit: 1 to 25 rows. The matches flash in the person\'s view.',
    schema: obj({ query: str(300, 'A selector (help selectors).', 1), limit: int(1, 25, 'Most rows, 10 usually; count says how many matched.') }),
  },
  {
    name: 'measure',
    title: 'Measure',
    risk: 'read',
    timeoutS: 120,
    description:
      'Exact numbers from the geometry kernel in mm, mm2, mm3 and degrees. One body: volume, area, centre of mass, bounding box, solids, shells, voids (shells minus solids: sealed inner voids), faces, edges, valid, and when not valid the Check list of problems with where each is. One face or edge: type, area or length, radius, centre, normal or axis. Two targets: minimum distance with both points and their delta, angle, centre distance; two bodies also give their overlap volume (0 means no interference), the solids and voids of their union, and their total. Three to 32 bodies: their mass properties total (volume, area, centre of mass, bounding box) and each body\'s volume and validity. section: "" or a plane ("Top offset 4 mm", a flat face): the one target body\'s cross-section there (area, loops, holes).',
    schema: obj({
      targets: arr(SEL('A body, a face, edge or vertex selector, or "(x, y, z)"'), 1, 32, 'One or two targets, or 3 to 32 bodies for their total.'),
      section: str(200, '"" for none, or a plane selector.'),
    }),
  },
  {
    name: 'check',
    title: 'Check an assembly',
    risk: 'read',
    timeoutS: 180,
    description:
      'Assembly checks by the kernel. interference: overlapping pairs (overlap_mm3, at_mm), with clearance also closer pairs (gap_mm). stack: bodies on each shared axis (shafts in bores) in order with gaps; flags a part free to slide (nothing on a side) or with nothing in its bore. sweep: bodies turned a full turn about axis: the first angle each hits another, both ways.',
    schema: obj({
      kind: en(CHECK_KINDS, 'Check'),
      bodies: arr(str(80, 'Body'), 0, 64, '[] all; sweep: the turning ones'),
      clearance: str(40, '"" or a length; stack: play held (0.5 mm)'),
      axis: str(200, 'sweep: an axis, or "" for theirs'),
    }),
  },
  {
    name: 'view',
    title: 'Look at the Part',
    risk: 'read',
    timeoutS: 90,
    description:
      'Pictures of the Part from fixed directions, drawn off screen: the person\'s view never moves. views: 1 to 4 of iso, iso_back, front, back, left, right, top, bottom, as one image (2 to 4: a labelled sheet), orthographic. sketch: a sketch\'s name for one picture straight at it, framed on its curves and drawn over the bodies (views unused), or "". hide: bodies to leave out. section: "" or "<plane> [offset <length> | middle] [flip]" (Top, Front, Right, a construction plane or a flat face) to cut the model there and cap the cut (middle: through the middle of the shown bodies). labels: none, bodies (names), or faces (handles of the larger visible faces, usable like find\'s). size: small (768 px) or large (1280 px). display: shaded_edges, shaded or wireframe; projection: orthographic, or perspective (mm_per_px then holds at the middle only). Pictures show shape, not sizes (no dimension values): use measure for numbers. Use at milestones and at the end. To move the person\'s own view use workspace.',
    schema: obj({
      views: arr(en(VIEW_DIRECTIONS, 'A direction'), 1, 4, 'Directions.'),
      hide: arr(str(80, 'A body name'), 0, 32, 'Bodies to leave out.'),
      section: str(120, '"" or "<plane> [offset <length> | middle] [flip]".'),
      labels: en(['none', 'bodies', 'faces'], 'What to write on the picture.'),
      size: en(['small', 'large'], 'Long side 768 or 1280 px.'),
      display: en(['shaded_edges', 'shaded', 'wireframe'], 'How the bodies are drawn.'),
      projection: en(['orthographic', 'perspective'], 'orthographic keeps mm_per_px true everywhere.'),
      sketch: str(120, '"" or a sketch\'s name: one picture straight at it.'),
    }),
  },
  {
    name: 'help',
    title: 'CAD reference',
    risk: 'read',
    timeoutS: 30,
    description:
      'Fixed reference text: sketch (entity kinds and their at numbers, macros and their parts, relations and dimensions with their refs), selectors (every form with examples), features (each tool\'s fields, faces it names), parameters (expressions, units, functions), checks (what to verify), traps (common mistakes and their fixes), errors (each reason, its fix), examples (the worked parts), example_plate, example_bracket, example_flange, example_chip (complete calls), guide (the CAD notes, if not given), sketch_tools (splines, fix, driven dimensions, trim, offset, fillet, mirror, patterns, project, import, copy, infer, solver), details (get_model holes and short briefs, set_params comments, construct methods and refs, direct kinds, edit_feature choice fields, extrude face and direction, pattern options and keys, measure totals and checks), workspace (every action), assemblies (shafts, bores, collars, fits, check), printing (PLA rules of thumb). Read it when unsure instead of guessing.',
    schema: obj({ topic: en(HELP_TOPICS, 'Topic') }),
  },
  {
    name: 'set_params',
    title: 'Set parameters',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Add, change, rename or remove parameters in one step. set rows: name (a letter or _, then letters, digits, _), kind length, angle or number, expr with units ("40 mm", "w/2", "15 deg"; number: "6"), comment ("" for none; on a parameter the Part has, "" keeps its comment and "-" removes it), rename_to ("" keeps the name; a rename updates every use). remove: names to delete. Rows may come in any order: all apply together. Nothing changes when an expression is bad, a removed parameter is still used, or a feature that built would fail after the change; the error names the row or the feature.',
    schema: obj({
      set: arr(
        obj({
          name: str(64, 'Parameter name', 1),
          kind: en(['length', 'angle', 'number'], 'Quantity'),
          expr: str(200, 'Value with units', 1),
          comment: str(200, '"" for none; on a parameter the Part has, "" keeps its comment, "-" removes it'),
          rename_to: str(64, '"" keeps the name'),
        }),
        0,
        40,
        'Rows to add or change.',
      ),
      remove: arr(str(64, 'Parameter name'), 0, 40, 'Parameters to delete.'),
    }),
  },
  {
    name: 'sketch',
    title: 'Sketch',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Make a sketch (edit "") or replace one (edit: name). on: Top, Front, Right, "<plane> offset <length>", a construction plane or a flat face ("Base.end"). entities {id, kind, at, construction}, at in mm of sketch u, v: point [u,v]; line, centerline [u1,v1,u2,v2]; polyline [u1,v1,...] (closed if last = first); rect [u1,v1,u2,v2] corners; center_rect [cu,cv,width,height]; circle [cu,cv,r]; arc [cu,cv,r,start,end deg] ccw; slot [u1,v1,u2,v2,r]; polygon [cu,cv,R,sides]; sector [cu,cv,r1,r2,start,end deg]; spline [u1,v1,...] fit points; ellipse [cu,cv,a,b,deg]; more (help sketch): control_spline, midpoint_line, rect_3pt, center_rect_3pt, parallelogram, circle_3pt, arc_slot, ellipse_arc, parabola, conic. constraints {id, kind, refs, value} in order: value "" (relation), an expression or "driven"; refs: ids, parts (l.start, c.center, r.top), origin, at(u, v) a place. fix and the person\'s tools (trim, offset, fillet, patterns, import of an attached drawing...) are rows: help sketch_tools.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      on: str(200, 'Top, Front, Right, "<plane> offset <length>", a construction plane, or one flat face; with edit, "" keeps it.'),
      entities: arr(
        obj({
          id: str(24, 'a-z, 0-9, _ (letter first, no double _); unique; not origin', 1),
          kind: en(SKETCH_ENTITY_KINDS, 'Kind'),
          at: arr(num('mm'), 2, 200, 'Numbers for the kind, mm in sketch u, v (polygon: the fourth number is the side count; control_spline: the degree, 3 or 5; conic: rho)'),
          construction: bool('Reference only: bounds no region'),
        }),
        0,
        150,
        'Shapes.',
      ),
      constraints: arr(
        obj({
          id: str(24, 'Constraint id', 1),
          kind: en([...SKETCH_CONSTRAINT_KINDS, ...SKETCH_TOOL_KINDS], 'Relation, dimension or sketch tool'),
          refs: arr(str(120, 'An id, a part (l.start), origin or at(u, v)'), 1, 40, 'What it ties or works on'),
          value: str(200, 'Dimensions: an expression ("w", "12 mm", "30 deg") or "driven". Relations: "". Tools: help sketch_tools.'),
        }),
        0,
        180,
        'Relations, dimensions and sketch tools, in order (at most 200 with the inferred ones).',
      ),
      infer: bool('true: lines and polyline sides drawn exactly along u or v also get horizontal or vertical'),
    }),
  },
  {
    name: 'extrude',
    title: 'Extrude',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Extrude regions of one sketch. regions: ["all"] (every hole stays open), region ids ["r2"], or ["at(u, v)"]. face: a flat face extruded with no sketch (sketch "", regions []), along its normal. direction: "" for the normal, or an axis to go along ("X axis", an edge, "normal of Top"). taper: a draft angle, "" for none. extent: blind (distance; flip for the other way), symmetric (distance in all, half each side), two (distance along, distance2 against), through or through_both (past every body), to (up to the face or vertex in to; distance is an extra offset or ""). op new makes a body (body_name, color #rrggbb, or ""). On a face the normal points out of the part: a cut into it needs flip true (or use hole). Returns body changes and the faces made (Name.start, .end, .side(...)). A failure, or a cut that removes nothing, changes nothing and says which way it missed.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      sketch: str(80, 'The sketch; "" with face'),
      regions: arr(str(80, '"all", a region id ("r2") or "at(u, v)" in mm'), 0, 40, 'Regions of the sketch; [] with face.'),
      face: SEL('"" or one flat face to extrude with no sketch'),
      direction: SEL('"" for the normal, or an axis to go along'),
      extent: en(['blind', 'symmetric', 'two', 'through', 'through_both', 'to'], 'How far'),
      distance: EXPR('blind, symmetric, two: a length; to: an offset or ""; through: ""'),
      distance2: EXPR('two: the length against the normal; else ""'),
      to: SEL('to: one face or vertex; else ""'),
      taper: EXPR('Draft angle: "" for straight walls, or an angle such as "5 deg" (+ narrows the profile as it goes); sketch profiles with blind, symmetric or two only'),
      flip: bool('Against the sketch normal'),
      op: OP,
      bodies: BODIES,
      body_name: BODY_NAME,
      color: COLOR,
    }),
  },
  {
    name: 'revolve',
    title: 'Revolve',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Revolve regions of one sketch about an axis (edit "" or a name). axis: "X axis", "Y axis", "Z axis", a sketch line ("Profile.ax"), one straight edge, or "axis of <round face>". extent full (360 deg, angle ""), one (angle; flip turns the other way), symmetric (angle in all, half each side), two (angle one way, angle2 the other). regions, op, bodies, body_name and color as in extrude. The regions must not cross the axis.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      sketch: str(80, 'The sketch', 1),
      regions: REGIONS,
      axis: SEL('The axis'),
      extent: en(['full', 'one', 'symmetric', 'two'], 'How far'),
      angle: EXPR('one, symmetric, two: an angle; full: ""'),
      angle2: EXPR('two: the other angle; else ""'),
      flip: bool('Turn the other way'),
      op: OP,
      bodies: BODIES,
      body_name: BODY_NAME,
      color: COLOR,
    }),
  },
  {
    name: 'sweep_loft',
    title: 'Sweep or loft',
    risk: 'edit',
    timeoutS: 240,
    description:
      'Sweep or loft (edit "" or a name). sweep: profiles = one region as "<sketch>", "<sketch> r2" or "<sketch> at(u, v)"; path = "<sketch>" (all its curves) or "<sketch>: l1, a2" (those curves, end to end), in another sketch; orientation follow or fixed. loft: profiles = two or more regions, one per sketch, in order; ruled for flat sides; path "". op, bodies, body_name and color as in extrude. These fail more often than extrude: keep profiles simple and check them with get_model first.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      kind: en(['sweep', 'loft'], 'Kind'),
      profiles: arr(str(200, '"<sketch>", "<sketch> r2" or "<sketch> at(u, v)"'), 1, 12, 'Profiles in order.'),
      path: str(200, 'sweep: the path; loft: ""'),
      orientation: en(['follow', 'fixed'], 'sweep: how the profile turns'),
      ruled: bool('loft: flat sides'),
      op: OP,
      bodies: BODIES,
      body_name: BODY_NAME,
      color: COLOR,
    }),
  },
  {
    name: 'modify',
    title: 'Fillet, chamfer or shell',
    risk: 'edit',
    timeoutS: 240,
    description:
      'Fillet or chamfer edges, or shell a body (edit "" or a name). fillet: targets are edges or faces (a face means all its edges and keeps following them as the part changes), size the radius. chamfer: size the distance, size2 a second distance or "" for equal, flip swaps the two. Edges take their tangent chain. shell: targets are the faces to open (at least one), size the wall thickness, inward true keeps the outer size. All targets on one body. Round outer edges before shelling. A failure (a radius larger than its wall, ...) changes nothing and names the edge.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      kind: en(['fillet', 'chamfer', 'shell'], 'Kind'),
      targets: arr(SEL('Faces or edges'), 1, 60, 'What to change.'),
      size: EXPR('Radius, distance or thickness'),
      size2: EXPR('chamfer: second distance or ""'),
      flip: bool('chamfer: swap the distances'),
      inward: bool('shell: wall inside'),
    }),
  },
  {
    name: 'pattern',
    title: 'Pattern or mirror',
    risk: 'edit',
    timeoutS: 240,
    description:
      'Repeat features, bodies or faces (edit "" or a name). linear: copies along about, count copies (the original included) spacing apart; about2, count2, spacing2 add a second direction ("" for none); flip reverses the first. circular: about is the axis, count copies over spacing as the total angle ("360 deg" spreads them evenly). mirror: about is the plane; count and spacing "". options: symmetric (copies on both sides of the first direction, or of a circular one), flip2 and symmetric2 (the second direction), extent and extent2 (spacing is from the original to the last copy, not between neighbours). skip: copies left out by key ("2"; "1.3" along both directions; "-1" on the other side; the reply lists the keys). of features: items are feature names (op source keeps each feature\'s own operation); bodies: body names; faces: face selectors on one body. Copies that miss the body fail by name: then use op new and combine.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      kind: en(['linear', 'circular', 'mirror'], 'Kind'),
      of: en(['features', 'bodies', 'faces'], 'What is copied'),
      items: arr(str(200, 'Feature, body or face'), 1, 40, 'What to copy.'),
      about: SEL('Axis (linear, circular) or plane (mirror)'),
      count: EXPR('Copies, a whole number 2 or more; mirror ""'),
      spacing: EXPR('linear: pitch (extent: the whole length); circular: total angle; mirror ""'),
      flip: bool('Reverse the first direction'),
      about2: SEL('linear: second direction or ""'),
      count2: EXPR('"" or count'),
      spacing2: EXPR('"" or pitch'),
      options: arr(en(PATTERN_OPTIONS, 'An option'), 0, 5, 'Choices that are on; [] for none.'),
      skip: arr(str(12, 'A copy key'), 0, 60, 'Copies left out; [] for none.'),
      op: en(['source', 'new', 'join', 'cut', 'intersect'], 'Operation'),
      bodies: BODIES,
    }),
  },
  {
    name: 'combine',
    title: 'Combine bodies',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Join, cut or intersect bodies (edit "" or a name). targets: the bodies that keep the result; tools: the bodies used, consumed unless keep_tools. Each entry is a body name or "bodies of <feature>" (a pattern\'s copies, for example) or "all bodies". Bodies that do not touch join as separate solids: the result notes it. Use it after making separate pieces with op new.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      op: en(['join', 'cut', 'intersect'], 'Operation'),
      targets: arr(str(200, 'A body name or "bodies of <feature>"'), 1, 16, 'Bodies changed.'),
      tools: arr(str(200, 'A body name, "bodies of <feature>" or "all bodies"'), 1, 40, 'Tool bodies.'),
      keep_tools: bool('Keep the tool bodies'),
    }),
  },
  bodySpec(true),
  editFeatureSpec(true),
  {
    name: 'undo',
    title: 'Undo or redo',
    risk: 'edit',
    timeoutS: 120,
    description:
      "action own: take back your own calls in this request, newest first (steps: how many), or with previous_turn true the whole previous Assistant request when it is still the newest change in the Part; it never undoes the person's changes. action undo or redo: the person's own Undo (Ctrl+Z) or Redo (Ctrl+Y), steps times, whoever made those steps; the result names each step and whose it was (person or an Assistant request). Use undo or redo only when the person asked for it.",
    schema: obj({
      action: en(['own', 'undo', 'redo'], 'own: your calls; undo, redo: the newest steps of anyone'),
      steps: int(0, 20, "How many; own: of this request's calls, 0 with previous_turn"),
      previous_turn: bool('own: undo the previous Assistant request instead'),
    }),
  },
  {
    name: 'delete',
    title: 'Delete features',
    risk: 'destructive',
    timeoutS: 120,
    confirm: 'Deletes features from the Part; one Undo takes back the whole request, this deletion with it.',
    description:
      'Delete features by name. The person is asked first. Refused, with nothing changed, while a feature not in the list uses one of them: the error names every user. Features that fail afterwards are listed. The person can bring them back with Undo, which takes back the whole request with them. To take back your own recent calls use undo instead (no question).',
    schema: obj({ features: arr(str(80, 'Feature name'), 1, 20, 'Features to delete.') }),
  },
  {
    name: 'construct',
    title: 'Construction geometry',
    risk: 'edit',
    timeoutS: 180,
    description:
      'Make a construction plane, axis or point. method, then refs in order: planes offset [plane] (value the distance), angle [plane, axis] (value the angle), three_points [p1, p2, p3], midplane [plane, plane2], normal_to_curve [curve] (value the position "50 %") or [curve, point]; axes two_points [p1, p2], cylinder [round face], edge [straight or round edge], two_planes [plane, plane2]; points vertex [point], center [round edge or spherical face], on_edge [curve] (value "25 %" or a length along it; from_end from its other end), edge_plane [edge, plane], coordinates (refs [], xyz three lengths). A plane: Top, Front, Right, a construction plane or a flat face; an axis: X axis, a construction axis, a sketch line ("Sk.l1"), an edge or "axis of <round face>"; a point: origin, a construction point, a vertex or "<sketch>.<id>[.start|.end|.center]"; a curve: an edge or "<sketch>.<id>". flip reverses a plane or an axis. Returns where it was built.',
    schema: obj({
      edit: EDIT,
      name: NAME,
      method: en(CONSTRUCT_METHODS, 'How it is made (plane, axis or point methods)'),
      refs: arr(SEL('A plane, axis, point, curve, edge or face selector'), 0, 3, 'What it is made from, in the method\'s order.'),
      value: EXPR('offset: a length; angle: an angle; normal_to_curve, on_edge: "50 %" or (on_edge) a length; else ""'),
      xyz: arr(EXPR('A length'), 0, 3, 'coordinates: x, y, z; else [].'),
      flip: bool('Reverse a plane or an axis'),
      from_end: bool('on_edge: measured from the other end'),
    }),
  },
  directSpec(true),
  {
    name: 'hole',
    title: 'Holes',
    risk: 'edit',
    timeoutS: 240,
    description:
      'Drill round holes into one flat face in one step: it makes a sketch and a cut extrude, named "<name> sketch" and "<name>". face: one flat face whose normal is along X, Y or Z. centers: model coordinates as expressions, "" for the coordinate along the face normal (on a face facing +Z: x and y, z ""). diameter: an expression, or "" with size ("M6", or inch "1/4-20", "#10-32 UNF") and fit close, normal or loose (the clearance hole: ISO 273, inch ASME B18.2.8) or tapped (the tap drill and a cosmetic thread: listed and drawn; thread modelled also cuts it into the wall as "<name> thread"). points "<sketch>": a hole at each of that sketch\'s points and circle centres (centers []); the holes follow those points when that sketch changes. depth through (through the face\'s body) or blind (distance deep). type counterbore (cb_diameter, cb_depth; "" with size: the socket head screw table, M3 to M30) or countersink (cs_diameter, "" with size: the countersunk screw table, M3 to M20; cs_angle "" for 90 deg) adds "<name> counterbore" or "<name> countersink" before the hole\'s cut. tip drill (blind only) ends each hole in a point (tip_angle "" for 118 deg): "<name> tip sketch" on its bottom and "<name> tip". The cut always goes into the material. Each centre must be within half the diameter of the face; a hole that breaks the face\'s edge makes a notch, and a warning says so. Change sizes later through parameters, or edit_feature on the sketch\'s dimensions (d is the diameter; h1x, h1y, h2x... the positions, signed in the face\'s u and v: get_model full shows them; holes at a sketch\'s points have none: move those points instead). A failure changes nothing.',
    schema: obj({
      name: NAME,
      face: SEL('One flat face whose normal is along X, Y or Z'),
      centers: arr(
        obj({ x: EXPR('Model X of the centre, or "" along the face normal'), y: EXPR('Model Y, or ""'), z: EXPR('Model Z, or ""') }),
        0,
        24,
        'Hole centres; [] with points.',
      ),
      points: str(80, '"" or a sketch whose points (point entities and circle centres) are the centres, seen along the face normal; the holes follow them; centers [] then'),
      diameter: EXPR('Diameter, or "" with size'),
      size: str(16, '"" or a fastener size that gives the diameter, with fit: metric "M6" (coarse), or inch "1/4-20", "#10-32", "1/4-28 UNF"'),
      fit: str(12, 'With size: close, normal or loose (clearance hole: ISO 273, inch ASME B18.2.8) or tapped (tap drill); else ""'),
      depth: en(['through', 'blind'], 'How deep'),
      distance: EXPR('blind: the depth; through: ""'),
      type: en(['simple', 'counterbore', 'countersink'], 'Hole type'),
      cb_diameter: EXPR('counterbore: its diameter ("" with size: the ISO 4762 socket head screw\'s); else ""'),
      cb_depth: EXPR('counterbore: its depth ("" with size: the screw table\'s); else ""'),
      cs_diameter: EXPR('countersink: its diameter at the face ("" with size: the ISO 10642 countersunk screw\'s); else ""'),
      cs_angle: EXPR('countersink: its included angle ("" for 90 deg); else ""'),
      tip: en(['flat', 'drill'], 'A blind hole\'s bottom: flat, or a drill point'),
      tip_angle: EXPR('tip drill: the point\'s included angle ("" for 118 deg); else ""'),
      thread: en(['cosmetic', 'modelled'], 'fit tapped: the thread recorded and drawn (cosmetic), or also cut into the wall (modelled)'),
    }),
  },
  workspaceSpec(true),
];

const toTool = (s: ToolSpec): AssistantTool => ({
  name: s.name,
  title: s.title,
  description: s.description,
  inputSchema: s.schema as unknown as AssistantObjectSchema,
  risk: s.risk,
  timeoutS: s.timeoutS,
  ...(s.confirm ? { confirm: s.confirm } : {}),
});

/** The 22 tools, by name (the order the app offers them in: it sorts workspace tools by name). */
export const CAD_TOOLS: readonly AssistantTool[] = Object.freeze(SPECS.map(toTool).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));

/**
 * The tools as Magnusim CAD offers them (projectLinks false: no projects, no simulation, no
 * Enclosure command): the body tool without its simulation field, the workspace tool without
 * send_to_simulation, the direct tool without the enclosure kind and its fields, and edit_feature's
 * words without the Enclosure's choice fields.
 */
const CAD_TOOLS_WITHOUT_PROJECTS: readonly AssistantTool[] = Object.freeze(
  CAD_TOOLS.map((t) => (t.name === 'body' ? toTool(bodySpec(false)) : t.name === 'workspace' ? toTool(workspaceSpec(false)) : t.name === 'direct' ? toTool(directSpec(false)) : t.name === 'edit_feature' ? toTool(editFeatureSpec(false)) : t)),
);

/**
 * The tools this page offers, by name: CAD_TOOLS where the host has projects (Magnusim), and in
 * Magnusim CAD (projectLinks false) CAD_TOOLS_WITHOUT_PROJECTS. The same 22 tools either way.
 */
export function cadToolsFor(o: { projectLinks: boolean }): readonly AssistantTool[] {
  return o.projectLinks ? CAD_TOOLS : CAD_TOOLS_WITHOUT_PROJECTS;
}

/** The tools' names, by name. */
export const TOOL_NAMES: readonly string[] = Object.freeze(CAD_TOOLS.map((t) => t.name));

/** The 13-tool core set for the eval's A/B runs (testing.ts setToolset('core')). */
export const CORE_TOOLSET: readonly string[] = Object.freeze(['get_model', 'find', 'measure', 'help', 'set_params', 'sketch', 'extrude', 'hole', 'revolve', 'modify', 'pattern', 'combine', 'undo']);

/** A tool by its name, or null. */
export function toolNamed(name: string): AssistantTool | null {
  return CAD_TOOLS.find((t) => t.name === name) ?? null;
}
