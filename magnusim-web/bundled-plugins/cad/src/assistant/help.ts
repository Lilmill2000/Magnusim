// The help tool's fixed reference (CAD tools spec §10.2): JSON rows {about, text} per topic, each
// topic at most 8 KB (example topics 12 KB), every string at most 2000 characters, as the app
// hands them to the model. `guide` is the CAD notes themselves, `errors` every reason with its
// fix, `features` each tool's fields and rules, `parameters`, `selectors` every form of the
// selector language, `sketch` the entity kinds (splines too), parts, DOF, the solver's ref signatures, joins
// and frames (infer and the solver's rules in sketch_tools), `checks` what to verify and how,
// `traps` the common mistakes, `examples` the index
// of the worked parts, `sketch_tools` fix, driven dimensions, places and the person's sketch tools
// as rows (trim, extend, offset, fillet, chamfer, mirror, patterns, project, intersect, break link,
// import of an attached drawing, copy as the person's Copy and Paste)
// with examples, and how a pattern's values change later. The example topics are the worked parts of examples.ts, one row per call
// with its whole input and its key results ({about, text, tool, input, result}: the call sits in
// the row itself, so a sketch's `at` lists stay at depth 7 of the reply's data, inside the app's
// 8; every other container is at most 6 deep). guide-example.test.ts runs every call.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { FUNCTION_NAMES, UNIT_NAMES } from '../doc/expr';
import { MAX_PARAM_NAME } from '../doc/params';
import { withCommas } from '../kernel/recognition';
import { RECOGNIZE_MAX_FILLET_FACES, RECOGNIZE_MAX_HOLE_FACES } from '../kernel/timeouts';
import { HINTS, REASONS, type ToolCode } from './errors';
import { WORKED_PARTS, type ResultValue } from './examples';
import { GUIDE } from './guide';
import type { AssistantTool } from '@magnusim/workspace';
import { CAD_TOOLS, cadToolsFor, HELP_TOPICS, type HelpTopic } from './schemas';
import { AT_WORDS, expandEntity, JOIN_TOL, KIND_DOF, type EntityKind } from './sketch/macros';
import { signatureWords, SIGNATURES, TOOL_DIMENSIONS, type ToolConstraintKind } from './sketch/signatures';

export interface HelpRow {
  about: string;
  text: string;
  /** Example topics: a complete call (the tool and its whole input), and its key results as a flat object. */
  tool?: string;
  input?: Record<string, unknown>;
  result?: Record<string, ResultValue>;
}

/** Each topic's most bytes as JSON; example topics hold complete calls. */
export const HELP_TOPIC_BYTES = 8 * 1024;
export const HELP_EXAMPLE_BYTES = 12 * 1024;
/** The app's cap on one string in a reply's data. */
export const HELP_STRING_MAX = 2000;
/** What the features topic adds to the row of a tool the page does not offer now (the eval's core set). */
export const NOT_OFFERED = 'Not offered now: do without it.';

/** A guide in rows, one per part (the app cuts each string in data at 2000 characters): GUIDE, or a Part's guide without some tools. */
export function guideRows(guide: string = GUIDE): HelpRow[] {
  return guide.split(/\n\n+/).map((part) => {
    const head = /^([A-Z]{3,})\b/.exec(part);
    return { about: head ? head[1].toLowerCase() : 'introduction', text: part };
  });
}

/** The reasons only a host with projects gives (sending to the simulation, Edit in CAD's project geometry). */
const PROJECT_REASONS: ReadonlySet<string> = new Set(['link_failed', 'no_link', 'opening_geometry']);

/** Every reason with its code and fix, then the sub-reasons (Magnusim CAD, `projects` false: none of a project's). */
function errorRows(projects = true): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const code of Object.keys(REASONS) as ToolCode[]) {
    for (const reason of REASONS[code]) if (projects || !PROJECT_REASONS.has(reason)) rows.push({ about: `${reason} (${code})`, text: HINTS[reason] });
  }
  for (const sub of ['no_overlap', 'wrong_side', 'too_short', 'off_body'] as const) rows.push({ about: `${sub} (detail.sub)`, text: HINTS[sub] });
  return rows;
}

/** Each tool's rules beyond its description: legal combinations, what it maps to, the faces it names. */
const FEATURE_NOTES: Readonly<Record<string, string>> = {
  body: 'One step. A body name is unique among bodies; it may equal a feature name. exclude leaves the body out of the geometry the project simulates.',
  check: 'help assemblies.',
  combine:
    'targets keep the result; tools go unless keep_tools. Entries: a body name, "bodies of <feature>" (a pattern\'s copies), "all bodies"; repeats are dropped and a target is taken out of tools. A join of bodies that do not touch is one body of several solids (a warning).',
  construct:
    'Methods, refs: help details. Its name is a plane, axis or point for other tools.',
  direct:
    'Kinds, fields: help details.',
  delete:
    'in_use (detail.users) while a feature not listed uses one: list those too, or change them first. One step; what fails afterwards is in broke.',
  edit_feature:
    'set: the fields get_model detail full lists for the feature (values; choices: help details) or a sketch dimension id (d, h1x): a value edit, refused (broke_downstream) when a working feature would fail; flipped names a sketch a dimension mirrored. rename_to, suppress and move ("before X", "after X", "end") go in the same step.',
  extrude:
    'face, direction: help details. Rules: distance2 only with two; to only with to; distance "" with through and through_both; bodies [] and body_name, color only with op new. Faces made: <Name>.start (on the sketch), <Name>.end (the far cap), <Name>.side(<entity>) per profile edge (r.top, p.3), <Name>.end(2) for a second profile. A miss gives detail.sub: wrong_side, off_body, too_short or no_overlap.',
  find: 'Handles (#f3 face, #e7 edge, #v2 vertex, #b1 body) last for this request; labels, and point_mm as "face at (x, y, z)", work in other fields; a flat face gives the frame a sketch on it gets.',
  get_model:
    "brief first. detail full or feature <name> adds the inputs in the tool's own fields, ready to resend with edit. user_changes: what the person changed since your last call (while this one ran too). editable false says why. Holes, a brief short of room: help details.",
  help: 'Fixed text; no Part needed. Every field of every tool is required: "", [] or false when unused.',
  hole:
    'Writes "<name> sketch" on the face: circles h1, h2...; d (diameter of h1) and equal for the rest; h1x, h1y... (distance_x, distance_y from the face origin, signed by the face frame: on a -X face z "b/2" becomes h1y "-(b/2)"); then the cut "<name>" into the face\'s body only. made lists both. A name is at most 33 characters. A tilted face: sketch on it and extrude cut with flip true.',
  measure:
    'Targets: body names, face, edge or vertex selectors and handles, "(x, y, z)", "selection", origin, construction planes, axes and points. Two bodies: distance, overlap_mm3, touching, union_solids, union_voids. Totals, checks: help details. section (one body): area, loops, holes, regions.',
  modify:
    'fillet, chamfer: a face (or "edges of <face>") is kept as the face, a live set; an edge ("A & B", #e3) a fixed set; kept_as says which. size2 "" is an equal chamfer; flip swaps. shell: targets are the faces taken off; inward true keeps the outer size. One body per call. Faces made: <Name>.fillet(k), <Name>.chamfer(k), <Name>.inner(<face>).',
  pattern:
    'linear: about an axis or edge, spacing a positive pitch (flip for the other way). options, skip: help details. circular: spacing the angle from the original to the last copy, "360 deg" evenly all round. mirror: about a plane (with offset: a construction plane in the same step), count and spacing "". features with op source repeat each one\'s own operation; bodies with op new make "<body> (Instance k)". Copies are <Name>.copy(k), mirrors <Name>.mirror.',
  revolve: 'axis: "X axis", "Y axis", "Z axis", a sketch line ("Profile.ax"), a straight edge, or "axis of <round face>". The profile may not cross the axis. Faces made: <Name>.side(<entity>) per profile edge.',
  set_params:
    'All rows apply together, in any order: a swap (w = 2*d while d was w/2) or a rename used by another row works. A rename updates every use. Comments: help details. A value that turns a working feature red changes nothing (broke_downstream); a sketch it mirrors is named in flipped.',
  sketch:
    'on "<plane> offset <length>" makes "<sketch> plane", or uses one made for the same plane and offset. Replace: edit "<name>" with every input (get_model feature <name> gives them). Reply: plane (origin, u, v in model axes, words), solver (state, dof, free, moved, dropped_inferred), regions (help selectors), open ends. help sketch has every kind and signature.',
  sweep_loft:
    "sweep: profiles are regions of one sketch; draw them on a plane through the path's start, square to it; path curves run end to end. loft: one region per sketch, in order, none with a hole. Faces: <Name>.side(<profile entity>@<path entity>) (<Name>.side(o): every side swept from o), <Name>.start, <Name>.end.",
  undo: 'steps n: your newest n calls of this request, back to before the oldest. previous_turn true (steps 0): the whole previous request, while it is the newest change. not_own_step when the person changed the Part after one of them.',
  workspace: 'help workspace has every action. Only reheal is an undo step (the rest says undo_step false). The person\'s view moves only with person_asked true or until they move it.',
  view: "Checked, but not strict on the first cloud dialect (its 20-tool budget). labels faces gives handles like find's; a section caps the cut. data.note says when the window was hidden or the person's sketch rolls later features back. A model that reads no images gets not_ready no_images: use measure and find.",
};

/** One tool's row: its title, how much it may change, its fields, and its rules. */
function toolRow(t: AssistantTool, note: string | undefined = FEATURE_NOTES[t.name]): HelpRow {
  return { about: t.name, text: `${t.title} (${t.risk}). Fields: ${Object.keys(t.inputSchema.properties).join(', ')}.${note ? ` ${note}` : ''}` };
}

/** The body tool's rules in Magnusim CAD (no projects, no simulation). */
const BODY_NOTE_WITHOUT_SIMULATION = 'One step. A body name is unique among bodies; it may equal a feature name.';

/** Each tool: its title, how much it may change, its fields, and its rules (the tools as this host offers them). */
function featureRows(tools: readonly AssistantTool[] = CAD_TOOLS, projects = true): HelpRow[] {
  return tools.map((t) => toolRow(t, !projects && t.name === 'body' ? BODY_NOTE_WITHOUT_SIMULATION : FEATURE_NOTES[t.name]));
}

const parameterRows = (): HelpRow[] => [
  {
    about: 'expressions',
    text: `Numbers with units (${UNIT_NAMES.join(', ')}, and the degree sign), + - * / ^ and parentheses, the functions ${FUNCTION_NAMES.join(', ')}, the constant pi, and parameter names. A unit goes right after a plain number ("40 mm", "w/2 + 1 mm", "sin(30 deg) * r"). ^ keeps whole-number dimensions. No conditions or comparisons.`,
  },
  {
    about: 'bare numbers',
    text: 'A number with no unit in a length or angle takes the Part\'s display unit: "20" in an inch Part is 20 in. Always write units.',
  },
  {
    about: 'names',
    text: `A parameter name is a letter or _, then letters, digits or _ (at most ${MAX_PARAM_NAME} characters), and not a unit, a function or pi. Names are unique.`,
  },
  {
    about: 'kinds',
    text: 'length (mm in replies), angle (degrees in replies) or number (no unit). A parameter may use other parameters, in any order, but never itself through others (a cycle is refused).',
  },
];

/**
 * Every form of the selector language (selectors/parse.ts), with examples. Magnusim CAD (no
 * projects) does not name the Enclosure's role: a kept Enclosure's faces still carry it, but the
 * Part there says nothing of the Enclosure (Daniel: hide all).
 */
const selectorRows = (projects = true): HelpRow[] => [
  {
    about: 'made by a feature',
    text: `FEATURE.ROLE: Base.start, Base.end, Base.side (all its sides), Base.side(l2) (the side swept from sketch entity l2; macro parts as r.top, p.3), Base.end(2) (the second profile's cap), Pipe.side(o@a2) (a sweep side: profile entity @ path entity; Pipe.side(o) is every side swept from o), Fillet 1.fillet(1), Shell 1.inner(Base.end), Row.copy(2) (a pattern copy), Flip.mirror, Split 1.cut. Roles: start, end, side, cut, inner, fillet, chamfer, copy, mirror, import, heal${projects ? ', enclosure' : ''}. A face merged by a join has every part's label.`,
  },
  {
    about: '~k',
    text: `Faces that share a label are numbered in a fixed order: Base.end~1, Base.end~2 (a face split by a cut, or two sides of one entity). The number of a split face can swap after an upstream edit: prefer a role or "at" selector when one names it.`,
  },
  {
    about: 'queries',
    text: `SCOPE faces|edges|vertices FILTER...: "Body 1 faces >Z". SCOPE: a body name, "feature Base" (what Base made), a feature name when no body has it, or "all". Filters run left to right, each narrowing the set.`,
  },
  {
    about: 'filters',
    text: `>Z farthest along Z by centre, >Z[2] the next level (levels count from [1]; ties within a millionth of the part size share a level), <Z nearest; +Z -Z flat faces facing +Z or -Z (out of the material); |Z faces whose normal (or a round face's axis) is parallel to Z, edges along Z; #Z perpendicular (circles lying across Z); axes X, Y, Z or (x, y, z); %plane %cylinder %cone %sphere %torus %bspline for faces, %line %circle %ellipse %bspline for edges; hole, boss (round faces going at least half way round); radius 3 mm, radius <= 3 mm, radius >= 3 mm; largest; smallest; nearest (x, y, z). Found by shape on solids, fillets on bodies of up to ${withCommas(RECOGNIZE_MAX_FILLET_FACES)} faces and holes on bodies of up to ${withCommas(RECOGNIZE_MAX_HOLE_FACES)} (else refused in words): fillet (a round face joining two faces smoothly, whatever made it; chamfers and rounds tangent on one side only are not), fillet 2 mm, fillet <= 2 mm (its largest radius), fillet >= 5 mm (its smallest; a torus's tube radius); hole 6 mm, hole <= 6 mm, hole >= 10 mm: every face of the whole drilled holes with that bore (wall, bottom, countersink, a rounded rim, which is a fillet too; holes that cross are one hole), while plain hole is per face. A plain size matches within max(0.001 mm, 1 %), <= and >= within 0.001 mm; write <= or >= (< and > are levels).`,
  },
  {
    about: 'points',
    text: `[BODY] face|edge|vertex at (x, y, z), model mm: "Body 1 face at (0, 0, 6)". Within max(0.05 mm, 0.002 x the body size); when two are that close the nearer wins only if it is at most half as far, else the answer lists both. None that close names the nearest and its distance.`,
  },
  {
    about: 'edges',
    text: `"edges of Base.end" (every edge of the face; a fillet or chamfer keeps the face, so the set follows later changes), "edges of Base.end %line" (with a filter: those edges, a fixed set), "edges of (Body 1 faces >Z) |X" (a face query goes in brackets, its own filters inside; the filters after the brackets pick among the edges), "Base.end & Base.side(r.top)" (the edge between two faces of one body), "Body 1 edges |Z".`,
  },
  {
    about: 'bodies',
    text: `A body name ("Body 1"), "bodies of Pattern 1" (the bodies a feature made), "all bodies" or "bodies". A name that is both a body and a feature: X.role, bodies of X and feature X read the feature; a plain name where a body goes reads the body.`,
  },
  {
    about: 'planes',
    text: `Top, Front, Right (or XY, XZ, YZ), a construction plane's name, or one flat face; then "offset <length>" moves it along its normal, "flip" the other way: "Top offset 12 mm", "Base.end offset 2 mm", "Front offset t/2 flip".`,
  },
  {
    about: 'axes',
    text: `X axis, Y axis, Z axis; a sketch line "Profile.ax" (or a macro part, Profile.r.left); a construction axis's name; one straight or round edge ("Base.end & Base.side(l1)"); "axis of Base.side(c1)" (a round face); "normal of Top".`,
  },
  {
    about: 'regions',
    text: `In the tool's sketch: all (every hole stays open), largest, r1 r2 ... (by area, largest first), at(u, v) in the sketch's mm. Another sketch: "Plate sketch r2"; "Plate sketch" alone is all of it; find "Plate sketch regions" lists every one. Replies list them short: past 8 regions, a run of one size is one row (ids r7..r102, count: each id works); get_model feature <sketch> regions full and find give each one's bounds and depth.`,
  },
  {
    about: 'handles and selection',
    text: `find gives each face, edge, vertex and body a handle for the rest of the request: #f3, #e7, #v2, #b1. A handle follows its face through rebuilds; one that moved says "moved: check", one that is gone answers selector_stale (call find again). "selection" is what the person has selected.`,
  },
  {
    about: 'names',
    text: `Names match whole and case-insensitively, the longest first ("Body 10" before "Body 1"). Quote a name that holds the selector's own characters: "Boss.v2".end. A field that takes one thing refuses a selector naming several, with up to 8 candidates (their handles, labels, words, centres).`,
  },
];

/** How to read measure's numbers (CAD tools spec §9.3); the build's checks follow (buildChecks). */
const measureChecks = (): HelpRow[] => [
  {
    about: 'volumes and areas',
    text: "measure gives the geometry kernel's exact numbers: plan the volume and size by hand first, then compare (within 0.1%). On free-form (B-spline) faces the volume is good to about 1.5e-7 of itself. Pictures cannot check sizes.",
  },
  {
    about: 'voids',
    text: 'voids = shells - solids for a body of closed solids: voids 1 is one sealed inner void. shells alone cannot tell, because two separate solids also give shells 2 (and voids 0). The kernel counts shells over the whole body. A surface body (solids 0) has no volume and voids null.',
  },
  {
    about: 'overlap and union',
    text: 'measure two bodies: overlap_mm3 above 0 means they interfere (0: they do not; touching says whether they meet); union_solids 1 means they would join into one piece; union_voids counts the sealed voids the two would close together. Neither body changes.',
  },
  {
    about: 'sections',
    text: 'measure one body with section "Top offset 4 mm", a construction plane or a flat face (with offset): the area of material in that plane, its loops, holes and pieces. A plane that misses the body gives area 0.',
  },
];

/** What to verify while building and at the end (CAD tools spec §10.2 checks). */
const buildChecks = (): HelpRow[] => [
  { about: 'plan first', text: 'Before the first edit, write down the parameters, the features in order and the expected volume, box, solids and voids, from a hand calculation (each example topic starts with one).' },
  { about: 'after each feature', text: 'Its state ok; the sign of the body change (a cut lowers the volume, a join raises it: no change means it missed); solids 1 unless you meant pieces; warnings read and acted on; its picture looked at.' },
  { about: 'sketches', text: 'Every sketch dof 0 (get_model lists dof, free says what still moves). An under-defined sketch is kept, but its shape can move when a parameter changes.' },
  { about: 'the end', text: 'measure each body: volume within 0.1% of the plan, the box to 0.01 mm, solids and voids as planned; two bodies meant to be apart: overlap_mm3 0; pieces meant to be one: union_solids 1. find "<body> faces hole radius <r>" counts holes of a size.' },
  { about: 'parameter walk', text: 'Change each driving parameter by +10%, check that the volume moves as the formula says and every feature stays ok (no flipped), then set it back.' },
  { about: 'symmetry', text: "A symmetric part's centroid_mm (measure) lies on its planes of symmetry." },
  {
    about: 'pictures',
    text: "An edit that answers ok carries one small picture of the Part (iso, framed on every shown body, their own colours) when the model reads images and the person has Pictures on; in a step (one answer) of several edits only the last carries it, the others say \"see this step's last edit\" (if it fails, a read after it or your next step brings it). data.picture says what it shows, data.picture_note why there is none. Look at it after each step: a feature missing, in the wrong place, the wrong way round or the wrong size shows there; fix it before going on. End with view iso, plus top, a section or labels faces for inner features. Pictures show shape, never sizes.",
  },
  { about: 'files', text: 'There is no export tool: tell the person to use Export STEP for a file.' },
];

/** Common mistakes and their fixes (CAD tools spec §10.2 traps). */
const trapRows = (): HelpRow[] => [
  { about: 'bare numbers', text: 'A number with no unit takes the Part\'s display unit ("20" in an inch Part is 20 in): always write units.' },
  { about: 'cuts into a face', text: "A face's normal points out of the part, so an extrude cut sketched on it needs flip true; hole cuts inward by itself. detail.sub says why a cut missed: wrong_side (flip it), off_body (the profile lies beside the body: read detail.frame), too_short (go further, or through)." },
  { about: 'side face frames', text: "+Y and -X faces have v running -Z (a point higher than such a face's origin has a negative v), and a -Z face has v running -Y. find shows each face's frame; hole takes model coordinates instead." },
  { about: 'overlap', text: 'cut and intersect need overlap: touching is not enough. A join also takes a body it shares a face with (an edge or a point is not enough). Joining pieces that do not touch makes one body of several solids. A pattern whose copies miss the body fails: use op new, then combine with "bodies of <pattern>".' },
  { about: 'regions', text: '"all" leaves every hole open: a circle inside a rectangle stays a hole, and so do overlapping holes, a keyhole and a hole a line crosses (each piece lies in the hole); an island in a hole is material again; overlapping shapes with nothing around them are their union. r1, r2... go by area, largest first, and change when the outline changes: at(u, v) keeps pointing at one place.' },
  { about: 'joined points', text: 'Points within 0.05 mm are one point: two circles drawn at one centre share it, so anchor it once (a second coincident on it repeats the first and is refused).' },
  { about: 'dimensions through 0', text: 'A signed dimension (distance_x, distance_y, angle) driven through 0 mirrors the sketch: set_params and edit_feature say so in flipped.' },
  { about: 'fillets and shells', text: 'Fillet before shell. A radius at or above its wall fails. Edges take their tangent chain. A fillet on a face follows its edges as the part changes; on edges it keeps those edges.' },
  { about: 'split faces', text: 'A face split by a cut is numbered ~1, ~2 (Base.end~2), and the numbers can swap after an upstream change: prefer a role, a query or "face at (x, y, z)".' },
  { about: 'risky features', text: "Sweep, loft and shell fail most often: keep profiles simple; a sweep profile on a plane through the path's start, square to it; loft sections one region each, with no hole." },
  { about: 'counts', text: 'Counts are whole numbers, 2 or more, the original included. A linear spacing is a positive pitch: flip goes the other way.' },
  { about: 'holes', text: 'hole needs a flat face facing along X, Y or Z, each centre on the face; a name is at most 33 characters (28 with a counterbore or countersink, 29 with a drill tip). size "M6" or "1/4-20" with fit gives the diameter (and with type counterbore or countersink, its size from the screw table); fit tapped records a cosmetic thread (thread modelled also cuts it, as "<name> thread"). points "<sketch>" drills at that sketch\'s points. A tilted face: sketch on it, then extrude cut with flip true.' },
  { about: 'words', text: '"2 mm higher" may mean relative or absolute: say which you did.' },
  { about: 'calls', text: 'Calls are limited: one sketch call holds a whole sketch, one set_params call every parameter; read only what you need.' },
  { about: 'limits', text: 'get_model limits says what is left of this request: steps_left (calls), usd_left when money is counted, changes_left when the request has a change limit. Past a limit an edit answers capped while reads (get_model, find, measure, view, help) still work: stop editing and tell the person what is left; they can send another message to carry on.' },
  { about: 'the person', text: 'Leave the person\'s features alone unless asked; never redo steps the person undid. delete asks the person; undo takes back only your own calls. busy: paused, stopped, taken_over and person_editing end your turn; step_declined: ask what to change; changed: get_model, then try again.' },
];

/** The worked parts as help rows: the plan, each call with its whole input and key results, the checks. */
const exampleRows = (topic: string): HelpRow[] => {
  const p = WORKED_PARTS.find((x) => x.topic === topic)!;
  return [{ about: 'the part', text: p.part }, ...p.calls.map((c) => ({ about: c.about, text: c.text, tool: c.tool, input: c.input, result: c.result })), { about: 'checks', text: p.checks }];
};

/**
 * The workspace tool: every action, what it takes and what it does (none of them but reheal is an
 * undo step). Magnusim CAD (`simulation` false): no send_to_simulation, and no word of a simulation.
 */
const workspaceRows = (simulation = true): HelpRow[] => [
  { about: 'fields', text: 'action names what to do; target, value and items carry what it needs ("" and [] when unused); person_asked true only when the person asked in this request for a change of their view or of a keybind. Every answer says what changed; data.undo_step false: view or session state, not an undo step (only reheal is one).' },
  { about: 'roll_back_to, roll_to_end', text: 'target: a feature; the bar goes just after it and later features roll back (not built). While the bar is not at the end your edits answer rolled_back at once: call roll_to_end first. roll_to_end takes no target.' },
  { about: 'show, hide', text: "target: a sketch, a construction plane, axis or point, or a body: the tree\'s eye. A sketch is shown until a later feature uses it, unless shown on purpose. body visibility does the same for bodies." },
  { about: 'see_through, opaque', text: `target a body, or items bodies: drawn see-through (what is inside and behind shows, edges stay; a click goes through to an opaque face behind) or opaque again, as INSPECT > See-through and the body's menu. Kept with the Part, not an undo step; pictures draw them so; get_model parts say see_through.${simulation ? " An Enclosure's air is always see-through." : ''}` },
  { about: 'origin_planes, rename_part', text: 'origin_planes value auto (drawn on an empty part and while one is selected or hovered) or always. rename_part value: the new name of the Part (the study title, as the tree\'s Rename part; at most 120 characters).' },
  { about: 'select, selection_filter', text: 'select items: selectors (help selectors), feature names, Top, Front, Right, X axis, Y axis, Z axis or origin; [] clears the selection. The person sees it selected; "selection" in later selectors reads it. selection_filter items: face, edge, vertex, body, feature, origin, sketch, region; [] lets everything be picked.' },
  { about: 'expand, collapse', text: 'target origin or bodies (the tree folders), tree (the design tree card; in a sketch for that sketch only), sketch_panel (the Sketch panel), sketch_details (its Details).' },
  { about: 'toolbar_show, toolbar_hide, toolbar_move, toolbar_reset, toolbar_width, toolbar_rows', text: 'target: a toolbar command id (solid.extrude, modify.shell, sketch.spline, ...). show puts it on the bar, hide in its group\'s More menu; move value "before <command id of the same group>" or end. toolbar_reset value model, sketch or "" (both). toolbar_width: target a group id (draw, sketch-modify, constrain, solid, modify, view, ...; sketch groups are on the sketch toolbar), value a width in px (24 to 1200), auto, or "" to read it; what does not fit goes into the More of the group and comes back when it is widened, as when the person drags the line at the right of the group; never narrower than its first command and its More (the reply gives the width applied, what is on the bar and what is in its More). toolbar_rows: target model, sketch or "" (the toolbar shown now), value 1 to 4, auto (3), or "" to read the rows and the widths set; large buttons need three rows, as when the person drags the bottom edge of the toolbar. Every command is on the toolbar by default (the main command of each group large, the rest small); toolbar_show answers where the person sees it. A drawing tool in a flyout (sketch.centerline in Line) moves with its flyout. The layout is the person\'s, in every project.' },
  { about: 'banana_show, banana_hide, banana_place', text: `The banana for scale: never a body${simulation ? ', never in the simulation' : ''}. banana_place value "x, y, z[, rot deg]" (mm; its underside at z). With target a sketch: that sketch\'s taped banana picture (seen while the sketch is edited), banana_place value "u, v" mm.` },
  { about: 'reload, keep_mine, retry_save, retry_kernel', text: 'reload: after another tab saved (the save chip); when this tab has a change of its own the person confirms first, as it is lost. keep_mine: this tab\'s version over the other tab\'s save; the person confirms. retry_save: a save that failed, now. retry_kernel: the geometry kernel that failed to start.' },
  { about: 'import_step, reheal', text: 'import_step: the file picker is the person\'s, so they are asked to pick the STEP (Import STEP in FILE, or a drop on the Part); call get_model after. reheal target: an Imported STEP; value the heal tolerance ("0.01 mm"; "" keeps it); items ["knit"] knits loose faces into solids, [] does not. One undo step, as Heal all in its panel.' },
  { about: 'export_step', text: 'target AP214 or AP242 ("": AP214); value the file name ("": the Part\'s name); items the bodies ([]: every shown body). The person\'s Export STEP panel opens filled in and they click Export: the download is theirs. Refused while they have a panel open.' },
  ...(simulation
    ? [
        {
          about: 'send_to_simulation',
          text: 'Save, then link the bodies included in the simulation into the project\'s geometry, as the app\'s Back does (body simulation include or exclude chooses them). Outcomes: linked, unchanged (the geometry has this design), nothing (no body included), kept-editing (the person answered the app\'s question with Keep editing), not-now; a refusal is link_failed with the app\'s words. value leave: after a send that went through, the Part closes as Back: no Part tool answers after it.',
        },
      ]
    : []),
  { about: 'keybind_get, keybind_set, keybind_reset, keybind_clear', text: 'The person\'s keyboard shortcuts for this Part\'s commands, while CAD is open (the app\'s own keybind tools serve Home and the project page). keybind_get target a command id (sketch.rectangle) or label, or "" for all: keys as stored (physical keys: "Shift+KeyR") and shown ("Shift+R"). Read them any time. Change them only when the person explicitly asked for that change in this request: person_asked true (else not_asked), and the app asks the person to confirm each change (No: step_declined, nothing changes). keybind_set value the keys ("Shift+R", "Ctrl+Alt+K", "F7"); a key another command has is key_taken unless items ["replace"]; keys the browser or Magnusim keep are refused, the app\'s Assistant panel key too (the person\'s, from Settings: assistant_panel_keys in keybind_get; a row\'s taken_by_app says a key of it is that key: it opens the panel, not the command). keybind_reset puts the defaults back; keybind_clear leaves it no key. Otherwise tell the person where to set it themselves: set_in in keybind_get (a right-click on the command on the toolbar or a views-menu row; Delete and Rename from the right-click on the Part row or a feature row; the tree or Sketch panel toggle from its collapse arrow; sketch Delete from the right-click on the selection; Place or finish from the right-click on Finish sketch). If the keybinds of the person could not be read, keybind_get says so and changes are refused.' },
  { about: "the person\'s view", text: 'fit; standard_view value front, back, left, right, top, bottom, iso, iso_back or home; normal_to target a flat face, a plane or a sketch; orbit_pivot target center, origin, "(x, y, z)" or a selector; section value off or "<plane> [offset <length> | middle] [flip]" (Top, Front, Right, a construction plane, a flat face or "selection"; flip keeps the other side): the Section view (INSPECT) the person sees, kept with the Part, following a construction plane or face it is on; projection value perspective or orthographic; display value shaded_edges, shaded or wireframe. These move what the person sees: only with person_asked true, or while they have not moved the view in this request (else busy view_latched). Pictures (view) never move it.' },
];

/** The index of the worked parts: what each one is, its calls and its topic. */
const exampleIndex = (): HelpRow[] =>
  WORKED_PARTS.map((p) => ({ about: p.topic, text: `${p.title}. ${p.brief ? `${p.brief} ` : ''}${p.calls.length} calls: ${[...new Set(p.calls.map((c) => c.tool))].join(', ')}. help ${p.topic} has every input whole.` }));

/** Each entity kind's parts (what refs name after "<id>."), from the tool's own expansion. */
function partsWords(kind: EntityKind, at: number[]): string {
  const r = expandEntity('x', kind, at, false);
  if (!r.ok) return '';
  const parts = Object.keys(r.macro.parts).filter(Boolean);
  return parts.length ? parts.map((p) => `x.${p}`).join(' ') : '';
}

/** Fix, driven dimensions, places and the person's sketch tools as rows of the sketch tool (sketch/ops.ts). */
const sketchToolRows = (): HelpRow[] => [
  { about: 'rows', text: 'The person\'s sketch tools are rows of constraints {id, kind, refs, value}, run in order on the sketch as the rows before them left it, solved: draw and dimension, then trim, fillet or pattern, then constrain what they made. "at(u, v)" in refs is a place in mm. The answer\'s made lists what each row made. Each tool stores what the person\'s tool stores.' },
  { about: 'fix', text: 'fix [p] holds a point where it is, fix [p, at(u, v)] at that place; fix [l] holds a curve (every point) where it is. A fixed point is fully defined.' },
  { about: 'driven', text: 'A dimension with value "driven" measures and never holds (grey in parentheses; the person\'s "Make it driven?"): use it when a driving one would over-define the sketch (the conflict names it). A last ref at(u, v) places any dimension\'s label: distance [r.bottom, at(0, -12)] "w".' },
  { about: 'trim and extend', text: 'trim [curve, at(u, v)]: the piece around the place goes, up to the nearest crossings (a piece cut in two keeps its id at the start, the other is "<id>.b"; new ends sit on the curves that cut them). extend [curve, at(u, v)]: the end nearest the place runs to the next curve. Example: {id:"t1", kind:"trim", refs:["c1", "at(0, 5)"], value:""}.' },
  { about: 'fillet and chamfer', text: 'fillet [corner] or [c1, c2] (two lines, or a line and an arc, meeting there), value the radius: an arc tangent to both and a driving Radius dimension; the corner stays as a construction point ("f1.corner"); the arc is "f1" in later rows. chamfer: value "d" (equal) or "d1; d2" (d1 along the first line); its line is "ch1". made gives the stored ids and dimensions (edit_feature takes them). Example: {id:"f1", kind:"fillet", refs:["r.tr"], value:"3 mm"}.' },
  { about: 'mirror', text: 'mirror [axis line, items...]: copies kept symmetric about the line (Symmetric relations; circles also Equal); an item lying on the axis is left out, a point on it shared. Items are entities or whole macros ("r"). Copies are "m1.<item>" in later rows ("m1.c1", "m1.r.top").' },
  { about: 'offset', text: 'offset [curve, at(u, v)], value the distance: the curve\'s chain (curves joined end to end) offset to the place\'s side; without at(u, v) both sides. It follows its source (a tie). Copies are "<id>.1.<curve>" (".2." for the other side). Example: {id:"o1", kind:"offset", refs:["p.1", "at(10, 12)"], value:"2 mm"}.' },
  { about: 'linear_pattern', text: 'linear_pattern [items...], value "count 4; spacing 10 mm; angle 0 deg" (count includes the items; angle from +u, 0 deg if left out); a second direction "count2 3; spacing2 8 mm; angle2 90 deg"; "along l1" or "along2 l2" runs along a line instead of an angle. Copies follow their items; copy k of item c1 is "<id>.k.c1" ("<id>.i_k.c1" with two directions).' },
  { about: 'circular_pattern', text: 'circular_pattern [centre point, items...], value "count 6" (the whole circle, equal spacing) or "count 4; angle 90 deg" (spread over that total angle). Copy k is "<id>.k.<item>". Example: {id:"p1", kind:"circular_pattern", refs:["origin", "h"], value:"count 6"}.' },
  { about: 'later', text: 'A pattern or offset keeps its row\'s id. edit_feature on the sketch sets its values: "<id>.count", "<id>.spacing", "<id>.angle", "<id>.count2", "<id>.spacing2", "<id>.angle2" (linear), "<id>.count", "<id>.angle" ("full" for the whole circle; circular), "<id>.distance" (offset); copies are made or removed. A replace keeps a row sent with its id (new values lay it out again), and removes one left out.' },
  { about: 'project and intersect', text: 'project [selector]: a face (its outer edges), an edge or a vertex of a body, or a body (its silhouette along the sketch normal), as fixed curves linked to the model (they follow it at every rebuild). intersect [body]: where the sketch plane cuts the body. One per row; the curves are "<id>" (one) or "<id>.1", "<id>.2"... Constrain to them, or trim and offset them after break_link. A replace keeps a row sent with its id (its refs are not read again).' },
  { about: 'break_link', text: 'break_link [curves or a project/intersect row id]: the linked curves become ordinary geometry where they are; constraints on them stay.' },
  {
    about: 'import',
    text: `import [attachment id]: a drawing the person attached (SVG or DXF: the attachment_id att-... of an "Attached drawing" line of their message), read as data and added as the person's Import SVG/DXF adds it: lines, arcs, circles, ellipses, splines and points; ends that meet share one point; no relations (under-defined: fix or dimension what must hold). entities may be [] with it. value "" or any of "scale <mm per drawing unit>; place origin|centre; layers <a>, <b>": the scale is the file's own by default (SVG: its width over its viewBox, else 96 px per inch; DXF: $INSUNITS, none read as mm), place origin puts the drawing's origin on the sketch's, centre its middle; layers (DXF) default to every layer the file has on. made gives read, skipped (text; scripts and links never run or fetched), size, open_ends, scale, layers and notes; its curves are "<id>.1", "<id>.2"... At most 20 MB, and a weight for the sketch solver of 10,000 (each point 1, a circle 1 more, an arc or ellipse 20 more, a partial ellipse 40 more): a heavier drawing is refused with its weight (leave layers out). One-shot: a replace that sends it again imports again. Example: {id:"i1", kind:"import", refs:["att-0123456789abcdef"], value:"place centre"}.`,
  },
  {
    about: 'copy',
    text: 'copy [items..., at(u, v)?]: new geometry copied from the items (entities, whole macros "r", or "all") as the person\'s Copy and Paste make it: construction kept; the relations and dimensions between copied items made again on the copies (a dimension keeps its expression); those that also tie anything not copied are left out, and made says how many (left_out, and a warning). at(u, v) puts the middle of the copy\'s box there; value "offset <du>, <dv>" moves it by that many mm instead; neither: where it was. value "from <sketch>" copies another sketch of this Part\'s items (its names as get_model gives them, or "all") into this one, at the same u, v whatever plane each lies on. "from clipboard" pastes what the person copied with Ctrl+C (in any Part; get_model\'s clipboard says what): all of it (refs ["all"], or only an at(u, v)), its copies "<id>.1", "<id>.2"... A dimension whose expression reads otherwise here takes the value it had (a warning says so). entities may be [] with it. Copies are "<id>.<item>" in later rows ("k1.c1", "k1.r.top"); get_model reads them back as plain entities. One-shot: a replace that sends it again copies again. Example: {id:"k1", kind:"copy", refs:["r", "c1", "at(60, 0)"], value:""}.',
  },
  // The sketch tool's answer (its description's last sentence until the import row's words left no
  // room within a description's 1,024 characters).
  { about: 'answer', text: "The sketch tool returns state, dof, free, moved, regions (r1...) and made (what each of these rows made)." },
  // v0.5.0: help sketch holds every entity kind within its size; the solver's rules sit here.
  { about: 'infer', text: 'infer true: lines, centerlines and polyline sides whose ends share v (or u) within 0.05 mm also get horizontal (or vertical). One that repeats a constraint of yours, or cannot hold with one, is left out and said so (dropped_inferred, and a warning naming which).' },
  { about: 'the solver', text: "It always runs. Coordinates are guesses: constraints and dimensions set the shape (moved: points that ended far from where you drew them). A conflict or duplicate is refused with the ids (a macro's own relation as internal): remove yours. No solution, or a shape shrunk to nothing, is refused. Under-defined is kept with a warning: free says what still moves; dof 0 is fully defined." },
];

/** Kinds whose words name their parts (help sketch keeps within its size). */
const NAMED_PARTS: ReadonlySet<EntityKind> = new Set(['midpoint_line', 'rect_3pt', 'center_rect_3pt', 'parallelogram', 'arc_slot']);

/** The sketch reference (CAD tools spec §10.2 sketch): kinds, parts, DOF, refs, joins, frames. */
const sketchRows = (): HelpRow[] => {
  const kinds: [EntityKind, number[], string][] = [
    ['point', [0, 0], 'the point is x itself'],
    ['line', [0, 0, 1, 0], 'x is the line'],
    ['centerline', [0, 0, 1, 0], 'construction: a revolve or mirror axis ("Sketch.x")'],
    ['polyline', [0, 0, 1, 0, 1, 1], 'points x.p0, x.p1...; side x.k runs from x.p(k-1) to x.pk; 2 DOF per point'],
    ['midpoint_line', [0, 0, 1, 0], 'x.line from x.start to x.end, its middle held on the construction point x.center'],
    ['circle', [0, 0, 1], 'x is the circle'],
    ['circle_3pt', [0, 0, 2, 0, 1, 1], 'x is the circle through the three points'],
    ['arc', [0, 0, 1, 0, 90], 'x is the arc'],
    ['rect', [0, 0, 2, 1], 'keeps its 2 horizontals and 2 verticals'],
    ['center_rect', [0, 0, 2, 1], 'a rect about the construction point x.center'],
    ['rect_3pt', [0, 0, 2, 1, 1], 'an angled rect: corners x.p1..x.p4, sides x.s1..x.s4 (x.sk from x.pk); s1 perpendicular to s2, s1 parallel to s3, s2 to s4'],
    ['center_rect_3pt', [0, 0, 2, 1, 30], 'rect_3pt\'s parts about the construction point x.center'],
    ['parallelogram', [0, 0, 2, 0, 3, 1], 'rect_3pt\'s parts, no perpendicular'],
    ['slot', [0, 0, 2, 0, 1], 'sides tangent to the arcs, the arcs equal; x.axis is construction'],
    ['arc_slot', [0, 0, 10, 2, 0, 90], 'arcs x.outer, x.inner about x.center, tangent to the caps x.cap_a, x.cap_b on the cap centres x.a, x.b (so the caps are equal)'],
    ['polygon', [0, 0, 1, 4], 'corners x.p1... on the construction circle x.circle, sides x.s1... (x.sk from x.pk), all equal'],
    ['sector', [0, 0, 1, 2, 0, 90], 'a ring piece; r1 0: a pie slice (no x.inner, 5 DOF)'],
    ['spline', [0, 0, 10, 5, 20, 0], 'x is the curve through its points x.p0, x.p1... (a cubic); x.start, x.end when open; x.h0, x.h1 are its end handles once a tangent gave them. A wing: spline [100,0, 50,6, 0,0, 50,-4, 100,0] closed'],
    ['control_spline', [0, 0, 10, 10, 20, 0, 30, 0, 3], 'x is the curve on its poles x.p0, x.p1...; x.start, x.end when open'],
    ['ellipse', [0, 0, 20, 10, 0], 'distance [x.center, x.major] is a, [x.center, x.minor] b; horizontal [x] levels the major axis'],
    ['ellipse_arc', [0, 0, 20, 10, 0, 0, 180], 'from x.start ccw to x.end'],
    ['parabola', [5, 0, 0, 0, -10, 10], 'distance [x.vertex, x.focus] is the focal length; horizontal [x] levels the axis'],
    ['conic', [0, 0, 40, 0, 10, 20, 0.5], 'tangent at its ends to the lines to x.top'],
  ];
  const rows: HelpRow[] = kinds.map(([kind, at, words]) => {
    const parts = kind === 'polyline' || kind === 'polygon' || kind === 'spline' || kind === 'control_spline' || NAMED_PARTS.has(kind) ? '' : partsWords(kind, at);
    const dof = KIND_DOF[kind];
    return { about: kind, text: `${kind} ${AT_WORDS[kind]}: ${words}${parts ? `. Parts: ${parts}` : ''}${dof !== null ? `. ${dof} DOF` : kind.endsWith('spline') ? '. 2 DOF per point' : ''}.` };
  });
  const relations = (Object.keys(SIGNATURES) as ToolConstraintKind[]).filter((k) => !TOOL_DIMENSIONS.includes(k));
  rows.push({ about: 'relations', text: `value "". Refs in the order written: ${relations.map((k) => `${k} [${signatureWords(k)}]`).join('; ')}. collinear makes two lines one line. A spline's curve takes tangent [s, curve] at an end they share (a fit spline gets its end handle there) and coincident [point, s] (the point slides on it); other relations take its points. Ellipses and parabolas take point_on [p, x], horizontal [x] (axis), tangent [line, ellipse] or at a shared end, equal, concentric; a conic tangent at its ends only. fix: help sketch_tools.` });
  rows.push({
    about: 'dimensions',
    text: `value an expression ("w", "12 mm", "30 deg"; a bare number takes the Part's unit), or "driven" (help sketch_tools); a last ref at(u, v) places its label. ${TOOL_DIMENSIONS.map((k) => `${k} [${signatureWords(k)}]`).join('; ')}. distance [p, circle] is to its edge; distance_x [p, q] = q.u - p.u and distance_y [p, q] = q.v - p.v are signed; distance_x [p] is p's u; angle [l1, l2] turns from l1's direction to l2's, angle [l] from +u (signed, deg).`,
  });
  rows.push({ about: 'ids and refs', text: 'Ids: a-z, 0-9 and _ (a letter first, at most 24, no double _, not origin), unique across entities and constraints. Refs: an id, a part (l.start, r.top, p.2, p.p2, c.center) or origin. A kept entity of an edited sketch keeps its points (and an id the sketch has, e_..., pt_..., is taken as it is).' });
  rows.push({ about: 'joins', text: `Ends within ${JOIN_TOL} mm of another entity's point are one point (the first entity's wins; refs follow; "joined" lists them), never two points of one entity, never the origin by itself; 0.05 to 0.5 mm apart is a warning (add coincident or fix the numbers). Points an edited sketch has apart stay apart. A rect corner drawn on a line's end is joined: no coincident needed.` });
  rows.push({ about: 'planes and faces', text: 'Top n+Z u+X v+Y; Front n-Y u+X v+Z; Right n+X u+Y v+Z. On a flat face (n out of the part): +Z u+X v+Y; -Z u+X v-Y; +Y u+X v-Z; -Y u+X v+Z; +X u+Y v+Z; -X u+Y v-Z; its origin is the model origin projected onto it. "<plane or face> offset <length> [flip]" makes "<sketch> plane".' });
  rows.push({ about: 'replace', text: 'edit "<name>" and every input: get_model feature <name> gives them in this form (splines, fix, driven dimensions, patterns, offsets and projections too: help sketch_tools). "" for on keeps where it lies. Keep the ids that stay: region keys and face names follow them. edit_feature changes one dimension by its id, or a pattern\'s value as <id>.count.' });
  return rows;
};

/** The details of get_model's holes and short brief, set_params' comments, construct, direct, edit_feature's choice fields, extrude's face and direction, pattern's options and keys, measure's totals and checks. In Magnusim CAD (`enclosure` false) none of the Enclosure: no command makes one there, and one made in Magnusim is not edited there. */
const detailRows = (enclosure = true): HelpRow[] => [
  {
    about: 'get_model and set_params',
    text: "get_model: a hole's sketch and cut show made_by hole and are edited as sketch and extrude. A brief short of room leaves out the parameters' comments, then their expressions (params_cut says so; every name stays), and counts older features ({earlier}): detail full or feature <name> has them. set_params: a change keeps the comment the parameter has (comment \"-\" removes it); each answer row says added or changed, and was.",
  },
  {
    about: 'construct planes',
    text: 'offset [plane], value the distance (flip: the other way). angle [plane, axis], value the angle; the axis lies in or along the plane. three_points [p1, p2, p3]. midplane [plane, plane2]: parallel planes give the middle, crossing ones the bisector. normal_to_curve [curve], value the position "50 %" (0 to 100 % of its length), or [curve, a point on it] with value "". flip turns the normal round.',
  },
  {
    about: 'construct axes and points',
    text: 'Axes: two_points [p1, p2]; cylinder [a cylindrical or conical face]; edge [a straight edge: along it; a round edge: its axis]; two_planes [plane, plane2]: where they cross; flip reverses it. Points: vertex [a point]; center [an arc, a circle or a spherical face]; on_edge [a curve], value "25 %" or a length from its start (from_end: from its other end); edge_plane [an edge, a plane]: where the edge crosses it; coordinates: refs [], xyz three lengths.',
  },
  {
    about: 'construct refs',
    text: 'A plane: Top, Front, Right, a construction plane by name or a flat face (not "<plane> offset ...": make that plane first). An axis: X axis, Y axis, Z axis, a construction axis, a sketch line ("Sk.l1"), a straight or round edge, "axis of <round face>". A point: origin, a construction point, a vertex selector, or a sketch point "<sketch>.<id>" (a point), "<sketch>.<line>.start|.end", "<sketch>.<circle or arc>.center". A curve: an edge, or a sketch curve "<sketch>.<id>". Nothing made by the feature itself or after it.',
  },
  {
    about: 'direct kinds',
    text: 'press_pull: faces (of one body), distance (above 0 adds, below 0 removes). delete_faces: faces; the neighbours grow over the gap; failing that, picked fillets (every one up to the largest) come off as fillets; a red one may list rest (get_model full) to add. Its panel\'s Fillets up to R / Holes up to D add what "<body> faces fillet <= R" / "<body> faces hole <= D" name. split: bodies, tool Top|Front|Right with distance the offset ("" for 0), or a flat face (its whole plane), or a body (keep_tool keeps it, else it is used up); the first piece keeps each body\'s name, the others are "<body> (2)"...' + (enclosure ? ' enclosure: bodies ([] every solid body made before it, other enclosures left out), shape box or cylinder_x|y|z, padding zero, percent (distance "10": of the part\'s size along each direction) or fixed (distance a length), sides rows {side, value} out from the part on one side; it never cuts: combine cut with keep_tools makes the fluid.' : '') + ' delete_body: bodies (one feature for them all) leave the model from this point in the history, as the person\'s Delete on a body in the tree; later features that use them fail; delete or suppress the feature to bring them back (edit changes which bodies). move_body: bodies (one feature for them all), as the person\'s Move/copy body: turn {angle, axis, pivot} first, then move [X, Y, Z] (lengths; [] none). axis X, Y or Z turns about that direction through pivot [X, Y, Z] ([] the centre of the bodies\' box just before it), or an axis selector (X axis: the origin axis itself, a construction axis, a straight or round edge, "axis of <round face>") with pivot []. Without copy the bodies keep their names and faces, so later features still find them; copy true leaves them and moves copies "<body> (Copy)" (new bodies). The reply gives each moved body or copy and the middle of its box (at_mm). repair: edit the feature whose get_model actions has repair; retry: edit the feature with retry. The reply says its state after (it may still fail).',
  },
  {
    about: 'edit_feature choices',
    text: 'set rows with a choice field and one of its words (on/off: "true" or "false"; get_model full shows choices now). extrude, revolve: flip, op (new, join, cut, intersect). sweep: orientation (follow, fixed), op. loft: ruled, op. chamfer: flip, mode (distance, two). shell: direction (inside, outside). combine: op (join, cut, intersect), keep_tools. linear pattern: op (source, new, join, cut, intersect), flip, symmetric, mode (spacing, extent), flip2, symmetric2, mode2. circular pattern: op, flip, symmetric, mode (full, angle). mirror: op. split: plane (Top, Front, Right) by a plane, keep_tool by a body. move_body: copy, about (X, Y, Z).' + (enclosure ? ' enclosure: shape (box, cylinder), axis (X, Y, Z), padding (zero, percent, fixed).' : '') + ' construction plane, axis: method, flip; point: method, along (distance, percent), from_end. A change that leaves the feature incomplete (a method without its picks) is refused: resend it with its tool.',
  },
  {
    about: 'extrude face and direction',
    text: 'face: one flat face of a body extruded with no sketch (sketch "", regions []), along its outward normal (flip: into the body); its side faces are named by the edges they came from. direction: "" for the normal, or an axis to extrude along: X axis, an edge, a sketch line, a construction axis, "normal of <plane>"; flip reverses it.',
  },
  {
    about: 'pattern options and keys',
    text: 'options: symmetric (copies on both sides of the first direction, or of a circular one), flip2 and symmetric2 (the second direction), extent and extent2 (spacing is the whole length from the original to the last copy). skip: copy keys to leave out. Keys: linear "i" along the first direction ("2" the first copy), "i.j" with a second one, negative on a symmetric side; circular "i"; "0" is the original. The reply lists every copy as "key (label)"; a key no copy has is refused.',
  },
  {
    about: 'measure totals and checks',
    text: 'Two bodies: total beside the pair. 3 to 32 bodies (all bodies): total {bodies, volume_mm3, area_mm2, centroid_mm, bbox_mm} as the Mass properties panel adds them, and each body\'s volume and valid. One body that is not valid: problems [{status, on ("face 3 of shell 1"), at_mm}], problem_total and problem_counts, as the Check panel lists them.',
  },
];

/** How to make a mechanism that holds together and turns, and how to check it (the check tool). */
const assemblyRows = (): HelpRow[] => [
  {
    about: 'a mechanism',
    text: 'Each part that moves on its own is its own body (op new): a shaft, each wheel, each collar, spacer, nut and washer. Parts that turn together are one body (join) or a press fit. A moving part needs three things: something in its bore holding it radially (a shaft, with a little play), something on each side holding it along the shaft, and room to turn. get_model parts lists every body: compare it with every part the request names.',
  },
  {
    about: 'shafts and bores',
    text: 'Draw each shaft and the bores on it about one centre (the same axis line: check finds axes by their round faces). A bore for a part that turns is larger than its shaft by a clearance (a D or hex shaft: the same shape of bore, larger all round); a bore the same size as its shaft (or smaller) is a press fit: the two are fixed together. A shaft that turns in a frame needs a bore in each plate. help printing has clearances for printed parts.',
  },
  {
    about: 'holding a part along its shaft',
    text: 'On each side of a moving part put one of: a shoulder (a step to a larger diameter on the shaft), a collar (a ring press-fitted on the shaft), a spacer (a tube between two parts, its bore like theirs), a nut or a washer, or the frame. Leave a small end play (0.1 to 0.3 mm) so it turns freely. Two wheels with a gap and nothing in it can slide into each other: put a spacer there.',
  },
  {
    about: 'room to turn',
    text: 'Everything a part sweeps when it turns (its outline turned about the axis) must be free of other parts, except parts that turn with it and gears it meshes with. Hands, cranks and keys sweep large circles: keep nuts, keys and frames out of them or at another height along the axis.',
  },
  {
    about: 'check interference',
    text: 'check kind interference, bodies [] (every body), a set (its pairs), or one body (it against every other): rows of pairs that overlap (overlap_mm3, at_mm). A bore drawn under its shaft (a press fit, as help printing gives it) shares a thin ring with it: its row says press_fit, counted apart from the overlaps (press_fits); it is expected, keep it. clearance "0.2 mm" also lists pairs closer than it (gap_mm; 0: they touch). Bodies far apart are skipped by their boxes first; rows are capped (rows_more). Meshing gears overlap a little where their teeth meet if the centre distance is short.',
  },
  {
    about: 'moving a part',
    text: 'direct kind move_body moves or turns a part after it is made (copy true: a copy of it), as the person\'s Move/copy body; its faces keep their names. After moving or turning parts of a mechanism, check interference again (and stack for parts on shafts).',
  },
  {
    about: 'check stack',
    text: 'check kind stack: each axis two bodies share, its parts in order (from_mm, to_mm along the axis), the bore radius, what each rides on (on) or turns in (in, a frame: a body holding shafts on two axes or more) with its radial play, what is fixed to it by a press fit, and on each side along the axis what it meets and how far ("Collar at 0 mm", or nothing). loose lists what is wrong: a part free to slide (nothing on a side, or it comes off its shaft), one that slides more than the play before it meets something, a bore nothing holds (empty, or much wider than what is inside). clearance: the play still counted as held (0.5 mm if ""). bodies: only the axes near them, and their findings. A frame\'s clearance hole and a body held on another axis are not flagged. Fix each, then check again.',
  },
  {
    about: 'check sweep',
    text: 'check kind sweep, bodies: the parts that turn together, axis: an axis ("Z axis", a construction axis, "axis of <round face>", an edge) or "" for the axis they share with another body. Each hit: the body met, first_deg turning counter-clockwise about the axis direction (back_deg the other way), at_mm, and overlap_mm3_1deg_past (the kernel turned a copy 1 degree past it). already: pairs that overlap before turning (check interference).',
  },
  {
    about: 'what it measures',
    text: 'stack and sweep cut the bodies near an axis by planes square to it, one between each two levels where a face starts or ends, so each slab is one shape all along: exact for parts extruded or revolved along the axis, close for others. The play is measured along rays from the axis (a D shaft in a D bore has its clearance). Radii and gaps are in mm, angles in degrees. Read the rows and judge: a stop the check found may be a part that is loose itself (its own row says so). A check the time limit stopped starts its text with "Stopped at the time limit" and lists only what it reached (note: what helps): never read it as all clear.',
  },
  {
    about: "the person's Check",
    text: 'The person runs the same checks in INSPECT > Check: Interference, Loose parts (stack) and Rotation (sweep), with the same words; a row there selects its bodies. Point them there to see a finding.',
  },
];

/** Printing in PLA: rules of thumb, each labelled so: printers and slicers differ. */
export const RT = '(rule of thumb: test on your printer)';
const printingRows = (): HelpRow[] => [
  {
    about: 'these figures',
    text: 'For FDM printing in PLA with a 0.4 mm nozzle and 0.2 mm layers. Every figure here is a rule of thumb: printers and slicers differ, so test a fit on the printer first. Tell the person the clearances you used.',
  },
  {
    about: 'holes and fits',
    text: `Printed holes come out small by about 0.1 to 0.2 mm ${RT}. A part that turns on a shaft: bore diameter = shaft + 0.3 to 0.5 mm ${RT}. A part that slides: + 0.2 to 0.3 mm ${RT}. A press fit: bore = shaft - 0.05 to 0.1 mm ${RT} (check interference lists it as press_fit, not a collision). Between two moving faces leave 0.3 to 0.5 mm ${RT}. Small holes under 3 mm are better drilled out after printing ${RT}.`,
  },
  {
    about: 'walls and pins',
    text: `Walls at least 1.2 mm (three lines of 0.4 mm) ${RT}; never under 0.8 mm ${RT}. Pins and shafts under 3 mm across break easily: use 4 mm or more, or a metal pin ${RT}. Gear teeth: module 1 mm or more ${RT}.`,
  },
  {
    about: 'overhangs and bridges',
    text: `Faces leaning out up to about 45 degrees from vertical print without support ${RT}; flatter ones need support, or a 45 degree chamfer under them. Flat bridges between two supports up to about 10 to 20 mm span print without support ${RT}. A horizontal hole is best as a teardrop (a 45 degree point on top) ${RT}.`,
  },
  {
    about: 'first layer',
    text: `The first layer spreads (elephant foot) by about 0.2 to 0.4 mm ${RT}: chamfer the bottom edges 0.3 to 0.5 mm ${RT}, above all on faces that must fit against another part.`,
  },
  {
    about: 'orientation',
    text: `Lay each part on its largest flat face. Holes for shafts print rounder standing up (along Z). Layers are the weak direction: a pin or shaft printed lying down is stronger than one standing up ${RT}. Gears and wheels print flat. Split a part that cannot print without much support into parts that join.`,
  },
  {
    about: 'sizes',
    text: `Heights come in steps of the layer height (0.2 mm) ${RT}; sizes across are good to about 0.1 to 0.2 mm ${RT}. Text and details under 0.5 mm are lost ${RT}.`,
  },
];

export const HELP: Readonly<Record<HelpTopic, readonly HelpRow[]>> = Object.freeze({
  sketch: sketchRows(),
  selectors: selectorRows(),
  features: featureRows(),
  parameters: parameterRows(),
  checks: [...measureChecks(), ...buildChecks()],
  traps: trapRows(),
  errors: errorRows(),
  examples: exampleIndex(),
  example_plate: exampleRows('example_plate'),
  example_bracket: exampleRows('example_bracket'),
  example_flange: exampleRows('example_flange'),
  example_chip: exampleRows('example_chip'),
  guide: guideRows(),
  sketch_tools: sketchToolRows(),
  details: detailRows(),
  workspace: workspaceRows(),
  assemblies: assemblyRows(),
  printing: printingRows(),
});

/**
 * The reference as Magnusim CAD gives it (projectLinks false: no projects, no simulation, no
 * Enclosure command): the tools as offered there (features), the workspace actions without
 * send_to_simulation, the details without the Enclosure, and no project's reasons (errors).
 */
const HELP_WITHOUT_PROJECTS: Readonly<Record<HelpTopic, readonly HelpRow[]>> = Object.freeze({
  ...HELP,
  features: featureRows(cadToolsFor({ projectLinks: false }), false),
  errors: errorRows(false),
  details: detailRows(false),
  workspace: workspaceRows(false),
  selectors: selectorRows(false),
});

/** The reference on this host: HELP where it has projects (Magnusim), else HELP_WITHOUT_PROJECTS. */
export const helpFor = (projectLinks: boolean): Readonly<Record<HelpTopic, readonly HelpRow[]>> => (projectLinks ? HELP : HELP_WITHOUT_PROJECTS);

export const isHelpTopic = (t: unknown): t is HelpTopic => typeof t === 'string' && (HELP_TOPICS as readonly string[]).includes(t);
