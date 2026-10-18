// The help tool's fixed reference (CAD tools spec §10.2): JSON rows {about, text, example?} per
// topic, each topic at most 8 KB (example topics 12 KB), every string at most 2000 characters and
// every container at most 6 deep in the reply, as the app hands them to the model.
// This is the skeleton: `guide` (the CAD notes themselves), `errors` (every reason with its fix),
// `features` (each tool's fields), `parameters`, `selectors` (every form of the selector
// language) and `sketch` (entity kinds, parts, DOF, the solver's ref signatures, joins, frames)
// are filled, `checks` starts with how to read measure's numbers; the topics whose tools come
// later say so, and are filled with them.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { FUNCTION_NAMES, UNIT_NAMES } from '../doc/expr';
import { MAX_PARAM_NAME } from '../doc/params';
import { HINTS, REASONS, type ToolCode } from './errors';
import { GUIDE } from './guide';
import { CAD_TOOLS, HELP_TOPICS, type HelpTopic } from './schemas';
import { AT_WORDS, expandEntity, JOIN_TOL, KIND_DOF, type EntityKind } from './sketch/macros';
import { signatureWords, SIGNATURES, TOOL_DIMENSIONS, type ToolConstraintKind } from './sketch/signatures';

export interface HelpRow {
  about: string;
  text: string;
  /** A complete call, and its key results as a flat object. */
  example?: { tool: string; input: Record<string, unknown>; result?: Record<string, string | number | boolean | null> };
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

/** Each tool: its title, how much it may change, and its fields. */
function featureRows(): HelpRow[] {
  return CAD_TOOLS.map((t) => ({
    about: t.name,
    text: `${t.title} (${t.risk}). Fields: ${Object.keys(t.inputSchema.properties).join(', ')}. Every field is required: "", [] or false when unused.`,
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
    text: `"edges of Base.end" (every edge of the face; a fillet or chamfer keeps the face, so the set follows later changes), "edges of Base.end %line" (with a filter: those edges, a fixed set), "Base.end & Base.side(r.top)" (the edge between two faces of one body), "Body 1 edges |Z".`,
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
    text: `In the tool's sketch: all (even-odd: holes stay open), largest, r1 r2 ... (by area, largest first), at(u, v) in the sketch's mm. Another sketch: "Plate sketch r2"; "Plate sketch" alone is all of it; find "Plate sketch regions" lists every one.`,
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

const later = (what: string): HelpRow[] => [{ about: 'not in this build yet', text: `${what} comes with the tools it describes. Until then each tool's own description says what its fields take.` }];

/** How to read measure's numbers (CAD tools spec §9.3); the rest of the checks come with their tools. */
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
  rows.push({ about: 'infer', text: 'infer true: lines, centerlines and polyline sides whose ends share v (or u) within 0.05 mm also get horizontal (or vertical). One that repeats a constraint of yours is left out and said so (dropped_inferred).' });
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
  checks: [...measureChecks(), ...later('The rest of the list of checks')],
  traps: later('The list of traps'),
  errors: errorRows(),
  examples: later('The worked examples'),
  example_plate: later('The plate example'),
  example_bracket: later('The bracket example'),
  example_flange: later('The flange example'),
  example_chip: later('The chip example'),
  guide: guideRows(),
});

export const isHelpTopic = (t: unknown): t is HelpTopic => typeof t === 'string' && (HELP_TOPICS as readonly string[]).includes(t);
