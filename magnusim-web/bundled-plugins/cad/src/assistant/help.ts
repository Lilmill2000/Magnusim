// The help tool's fixed reference (CAD tools spec §10.2): JSON rows {about, text} per topic, each
// topic at most 8 KB (example topics 12 KB), every string at most 2000 characters, as the app
// hands them to the model. `guide` is the CAD notes themselves, `errors` every reason with its
// fix, `features` each tool's fields and rules, `parameters`, `selectors` every form of the
// selector language, `sketch` the entity kinds, parts, DOF, the solver's ref signatures, joins
// and frames, `checks` what to verify and how, `traps` the common mistakes, `examples` the index
// of the worked parts. The example topics are the worked parts of examples.ts, one row per call
// with its whole input and its key results ({about, text, tool, input, result}: the call sits in
// the row itself, so a sketch's `at` lists stay at depth 7 of the reply's data, inside the app's
// 8; every other container is at most 6 deep). guide-example.test.ts runs every call.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { FUNCTION_NAMES, UNIT_NAMES } from '../doc/expr';
import { MAX_PARAM_NAME } from '../doc/params';
import { HINTS, REASONS, type ToolCode } from './errors';
import { WORKED_PARTS, type ResultValue } from './examples';
import { GUIDE } from './guide';
import { CAD_TOOLS, HELP_TOPICS, type HelpTopic } from './schemas';
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

/** The guide in rows, one per part (the app cuts each string in data at 2000 characters). */
function guideRows(): HelpRow[] {
  return GUIDE.split(/\n\n+/).map((part) => {
    const head = /^([A-Z]{3,})\b/.exec(part);
    return { about: head ? head[1].toLowerCase() : 'introduction', text: part };
  });
}

/** Every reason with its code and fix, then the sub-reasons. */
function errorRows(): HelpRow[] {
  const rows: HelpRow[] = [];
  for (const code of Object.keys(REASONS) as ToolCode[]) {
    for (const reason of REASONS[code]) rows.push({ about: `${reason} (${code})`, text: HINTS[reason] });
  }
  for (const sub of ['no_overlap', 'wrong_side', 'too_short', 'off_body'] as const) rows.push({ about: `${sub} (detail.sub)`, text: HINTS[sub] });
  return rows;
}

/** Each tool's rules beyond its description: legal combinations, what it maps to, the faces it names. */
const FEATURE_NOTES: Readonly<Record<string, string>> = {
  body: 'One step. A body name is unique among bodies; it may equal a feature name. exclude leaves the body out of the geometry the project simulates.',
  combine:
    'targets keep the result; tools go unless keep_tools. Entries: a body name, "bodies of <feature>" (a pattern\'s copies), "all bodies"; repeats are dropped and a target is taken out of tools. A join of bodies that do not touch is one body of several solids (a warning).',
  delete:
    'The person is asked first. in_use (detail.users) while a feature not listed uses one: list those too, or change them first. One step; what fails afterwards is in broke. The person gets them back with Ctrl+Z; for your own calls use undo.',
  edit_feature:
    'set: the fields get_model detail full lists for the feature (distance, size, count...) or a sketch dimension id (d, h1x): a value edit, refused (broke_downstream) when a working feature would fail; flipped names a sketch a dimension mirrored. rename_to, suppress and move ("before X", "after X", "end") go in the same step.',
  extrude:
    'Rules: distance2 only with two; to only with to; distance "" with through and through_both; bodies [] and body_name, color only with op new. Faces made: <Name>.start (on the sketch), <Name>.end (the far cap), <Name>.side(<entity>) per profile edge (r.top, p.3), <Name>.end(2) for a second profile. A miss gives detail.sub: wrong_side, off_body, too_short or no_overlap.',
  find: 'Handles (#f3 face, #e7 edge, #v2 vertex, #b1 body) last for this request; labels, and point_mm as "face at (x, y, z)", work in other fields; a flat face gives the frame a sketch on it gets. count is every match, limit only cuts rows.',
  get_model:
    "brief first. detail full or feature <name> adds the inputs in the tool's own fields, ready to resend with edit; a hole's sketch and cut show made_by hole and are edited as sketch and extrude. user_changes: what the person changed since your last call (while this one ran too). A brief short of room leaves out the parameters' comments, then their expressions (params_cut says so; every name stays), and counts older features ({earlier}): detail full or feature <name> has them. editable false says why.",
  help: 'Fixed text; no Part needed. Every field of every tool is required: "", [] or false when unused.',
  hole:
    'Writes "<name> sketch" on the face: circles h1, h2...; d (diameter of h1) and equal for the rest; h1x, h1y... (distance_x, distance_y from the face origin, signed by the face frame: on a -X face z "b/2" becomes h1y "-(b/2)"); then the cut "<name>" into the face\'s body only. made lists both. A name is at most 33 characters. A tilted face: sketch on it and extrude cut with flip true.',
  measure:
    'Targets: body names, face, edge or vertex selectors and handles, "(x, y, z)", "selection", origin, construction planes, axes and points. One body: volume, area, centroid, bbox, solids, shells, voids. Two bodies: distance, overlap_mm3, touching, union_solids, union_voids. section (one body): area, loops, holes, regions.',
  modify:
    'fillet, chamfer: a face (or "edges of <face>") is kept as the face, a live set; an edge ("A & B", #e3) a fixed set; kept_as says which. size2 "" is an equal chamfer; flip swaps. shell: targets are the faces taken off; inward true keeps the outer size. One body per call. Faces made: <Name>.fillet(k), <Name>.chamfer(k), <Name>.inner(<face>).',
  pattern:
    'linear: about an axis or edge, spacing a positive pitch (flip for the other way). circular: spacing the angle from the original to the last copy, "360 deg" evenly all round. mirror: about a plane (with offset: a construction plane in the same step), count and spacing "". features with op source repeat each one\'s own operation; bodies with op new make "<body> (Instance k)". Copies are <Name>.copy(k), mirrors <Name>.mirror.',
  revolve: 'axis: "X axis", "Y axis", "Z axis", a sketch line ("Profile.ax"), a straight edge, or "axis of <round face>". The profile may not cross the axis. Faces made: <Name>.side(<entity>) per profile edge.',
  set_params:
    'All rows apply together, in any order: a swap (w = 2*d while d was w/2) or a rename used by another row works. A rename updates every use. A change keeps the comment the parameter has (comment "-" removes it); each answer row says added or changed, and was. A value that turns a working feature red changes nothing (broke_downstream); a sketch it mirrors is named in flipped.',
  sketch:
    'on "<plane> offset <length>" makes "<sketch> plane", or uses one made for the same plane and offset. Replace: edit "<name>" with every input (get_model feature <name> gives them). Reply: plane (origin, u, v in model axes, words), solver (state, dof, free, moved, dropped_inferred), regions (id, area, at, holes), open ends. help sketch has every kind and signature.',
  sweep_loft:
    "sweep: profiles are regions of one sketch; draw them on a plane through the path's start, square to it; path curves run end to end. loft: one region per sketch, in order, none with a hole. Faces: <Name>.side(<profile entity>@<path entity>) (<Name>.side(o): every side swept from o), <Name>.start, <Name>.end.",
  undo: 'steps n: your newest n calls of this request, back to before the oldest. previous_turn true (steps 0): the whole previous request, while it is the newest change. not_own_step when the person changed the Part after one of them.',
  view: "Checked, but not strict on the first cloud dialect (its 20-tool budget). labels faces gives handles like find's; a section caps the cut. data.note says when the window was hidden or the person's sketch rolls later features back. A model that reads no images gets not_ready no_images: use measure and find.",
};

/** Each tool: its title, how much it may change, its fields, and its rules. */
function featureRows(): HelpRow[] {
  return CAD_TOOLS.map((t) => ({
    about: t.name,
    text: `${t.title} (${t.risk}). Fields: ${Object.keys(t.inputSchema.properties).join(', ')}.${FEATURE_NOTES[t.name] ? ` ${FEATURE_NOTES[t.name]}` : ''}`,
  }));
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

/** Every form of the selector language (selectors/parse.ts), with examples. */
const selectorRows = (): HelpRow[] => [
  {
    about: 'made by a feature',
    text: `FEATURE.ROLE: Base.start, Base.end, Base.side (all its sides), Base.side(l2) (the side swept from sketch entity l2; macro parts as r.top, p.3), Base.end(2) (the second profile's cap), Pipe.side(o@a2) (a sweep side: profile entity @ path entity; Pipe.side(o) is every side swept from o), Fillet 1.fillet(1), Shell 1.inner(Base.end), Row.copy(2) (a pattern copy), Flip.mirror, Split 1.cut. Roles: start, end, side, cut, inner, fillet, chamfer, copy, mirror, import, heal, enclosure. A face merged by a join has every part's label.`,
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
    text: `>Z farthest along Z by centre, >Z[2] the next level (levels count from [1]; ties within a millionth of the part size share a level), <Z nearest; +Z -Z flat faces facing +Z or -Z (out of the material); |Z faces whose normal (or a round face's axis) is parallel to Z, edges along Z; #Z perpendicular (circles lying across Z); axes X, Y, Z or (x, y, z); %plane %cylinder %cone %sphere %torus %bspline for faces, %line %circle %ellipse %bspline for edges; hole, boss (round faces going at least half way round); radius 3 mm; largest; smallest; nearest (x, y, z).`,
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
    text: `In the tool's sketch: all (every hole stays open), largest, r1 r2 ... (by area, largest first), at(u, v) in the sketch's mm. Another sketch: "Plate sketch r2"; "Plate sketch" alone is all of it; find "Plate sketch regions" lists every one.`,
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
  { about: 'after each feature', text: 'Its state ok; the sign of the body change (a cut lowers the volume, a join raises it: no change means it missed); solids 1 unless you meant pieces; warnings read and acted on.' },
  { about: 'sketches', text: 'Every sketch dof 0 (get_model lists dof, free says what still moves). An under-defined sketch is kept, but its shape can move when a parameter changes.' },
  { about: 'the end', text: 'measure each body: volume within 0.1% of the plan, the box to 0.01 mm, solids and voids as planned; two bodies meant to be apart: overlap_mm3 0; pieces meant to be one: union_solids 1. find "<body> faces hole radius <r>" counts holes of a size.' },
  { about: 'parameter walk', text: 'Change each driving parameter by +10%, check that the volume moves as the formula says and every feature stays ok (no flipped), then set it back.' },
  { about: 'symmetry', text: "A symmetric part's centroid_mm (measure) lies on its planes of symmetry." },
  { about: 'pictures', text: 'End with view iso, plus top, a section or labels faces for inner features. Pictures show shape, never sizes.' },
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
  { about: 'holes', text: 'hole needs a flat face facing along X, Y or Z, each centre on the face; a name is at most 33 characters. A tilted face: sketch on it, then extrude cut with flip true.' },
  { about: 'words', text: '"2 mm higher" may mean relative or absolute: say which you did.' },
  { about: 'calls', text: 'Calls are limited: one sketch call holds a whole sketch, one set_params call every parameter; read only what you need.' },
  { about: 'the person', text: 'Leave the person\'s features alone unless asked; never redo steps the person undid. delete asks the person; undo takes back only your own calls. busy: paused, stopped, taken_over and person_editing end your turn; step_declined: ask what to change; changed: get_model, then try again.' },
];

/** The worked parts as help rows: the plan, each call with its whole input and key results, the checks. */
const exampleRows = (topic: string): HelpRow[] => {
  const p = WORKED_PARTS.find((x) => x.topic === topic)!;
  return [{ about: 'the part', text: p.part }, ...p.calls.map((c) => ({ about: c.about, text: c.text, tool: c.tool, input: c.input, result: c.result })), { about: 'checks', text: p.checks }];
};

/** The index of the worked parts: what each one is, its calls and its topic. */
const exampleIndex = (): HelpRow[] =>
  WORKED_PARTS.map((p) => ({ about: p.topic, text: `${p.title}. ${p.calls.length} calls: ${[...new Set(p.calls.map((c) => c.tool))].join(', ')}. help ${p.topic} has every input whole.` }));

/** Each entity kind's parts (what refs name after "<id>."), from the tool's own expansion. */
function partsWords(kind: EntityKind, at: number[]): string {
  const r = expandEntity('x', kind, at, false);
  if (!r.ok) return '';
  const parts = Object.keys(r.macro.parts).filter(Boolean);
  return parts.length ? parts.map((p) => `x.${p}`).join(' ') : '';
}

/** The sketch reference (CAD tools spec §10.2 sketch): kinds, parts, DOF, refs, joins, frames. */
const sketchRows = (): HelpRow[] => {
  const kinds: [EntityKind, number[], string][] = [
    ['point', [0, 0], 'the point is x itself'],
    ['line', [0, 0, 1, 0], 'x is the line'],
    ['centerline', [0, 0, 1, 0], 'a construction line: a revolve or mirror axis ("Sketch.x")'],
    ['polyline', [0, 0, 1, 0, 1, 1], 'points x.p0, x.p1, ...; side x.k runs from x.p(k-1) to x.pk; closed when the last point is the first (x.p0 again); 2 DOF per point'],
    ['circle', [0, 0, 1], 'x is the circle'],
    ['arc', [0, 0, 1, 0, 90], 'x is the arc, counter-clockwise from start to end'],
    ['rect', [0, 0, 2, 1], 'keeps its 2 horizontals and 2 verticals'],
    ['center_rect', [0, 0, 2, 1], 'a rect with a construction centre point x.center kept midway between x.bl and x.tr'],
    ['slot', [0, 0, 2, 0, 1], 'x.a and x.b are the arc centres; sides tangent to the arcs, the arcs equal; x.axis is construction'],
    ['polygon', [0, 0, 1, 4], 'corners x.p1... on the construction circle x.circle (x.p1 at +u), sides x.s1... (x.sk from x.pk), all equal'],
    ['sector', [0, 0, 1, 2, 0, 90], 'a ring piece: arcs x.inner, x.outer on x.center, radial lines x.start, x.end through the centre'],
  ];
  const rows: HelpRow[] = kinds.map(([kind, at, words]) => {
    const parts = kind === 'polyline' || kind === 'polygon' ? '' : partsWords(kind, at);
    const dof = KIND_DOF[kind];
    return { about: kind, text: `${kind} ${AT_WORDS[kind]}: ${words}${parts ? `. Parts: ${parts}` : ''}${dof !== null ? `. ${dof} DOF` : ''}.` };
  });
  const relations = (Object.keys(SIGNATURES) as ToolConstraintKind[]).filter((k) => !TOOL_DIMENSIONS.includes(k));
  rows.push({ about: 'relations', text: `value "". Refs in the order written: ${relations.map((k) => `${k} [${signatureWords(k)}]`).join('; ')}. point_on is on a line or a circle/arc; collinear makes two lines one line.` });
  rows.push({
    about: 'dimensions',
    text: `value an expression ("w", "12 mm", "30 deg"; a bare number takes the Part's unit). ${TOOL_DIMENSIONS.map((k) => `${k} [${signatureWords(k)}]`).join('; ')}. distance [p, circle] is to its edge; distance_x [p, q] = q.u - p.u and distance_y [p, q] = q.v - p.v are signed; distance_x [p] is p's u; angle [l1, l2] turns from l1's direction to l2's, angle [l] from +u (signed, deg).`,
  });
  rows.push({ about: 'ids and refs', text: 'Ids: a-z, 0-9 and _ (a letter first, at most 24, no double _, not origin), unique across entities and constraints. Refs: an id, a part (l.start, r.top, p.2, p.p2, c.center) or origin. A kept entity of an edited sketch keeps its points (and an id the sketch has, e_..., pt_..., is taken as it is).' });
  rows.push({ about: 'joins', text: `Ends within ${JOIN_TOL} mm of another entity's point are one point (the first entity's wins; refs follow; "joined" lists them), never two points of one entity, never the origin by itself; 0.05 to 0.5 mm apart is a warning (add coincident or fix the numbers). Points an edited sketch has apart stay apart. A rect corner drawn on a line's end is joined: no coincident needed.` });
  rows.push({ about: 'infer', text: 'infer true: lines, centerlines and polyline sides whose ends share v (or u) within 0.05 mm also get horizontal (or vertical). One that repeats a constraint of yours, or cannot hold with one, is left out and said so (dropped_inferred, and a warning naming which).' });
  rows.push({ about: 'the solver', text: "It always runs. Coordinates are guesses: constraints and dimensions set the shape (moved: points that ended far from where you drew them). A conflict or duplicate is refused with the ids (a macro's own relation as internal): remove yours. No solution, or a shape shrunk to nothing, is refused. Under-defined is kept with a warning: free says what still moves; dof 0 is fully defined." });
  rows.push({ about: 'planes and faces', text: 'Top n+Z u+X v+Y; Front n-Y u+X v+Z; Right n+X u+Y v+Z. On a flat face (n out of the part): +Z u+X v+Y; -Z u+X v-Y; +Y u+X v-Z; -Y u+X v+Z; +X u+Y v+Z; -X u+Y v-Z; its origin is the model origin projected onto it. "<plane or face> offset <length> [flip]" makes "<sketch> plane".' });
  rows.push({ about: 'replace', text: 'edit "<name>" and every input: get_model feature <name> gives them in this form. "" for on keeps where it lies. Keep the ids that stay: region keys and face names follow them. edit_feature changes one dimension by its id. Sketches with projected edges, splines, patterns, fixed points or driven dimensions are not replaced (edit_feature still changes their values).' });
  return rows;
};

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
});

export const isHelpTopic = (t: unknown): t is HelpTopic => typeof t === 'string' && (HELP_TOPICS as readonly string[]).includes(t);
