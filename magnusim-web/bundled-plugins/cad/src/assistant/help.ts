// The help tool's fixed reference (CAD tools spec §10.2): JSON rows {about, text, example?} per
// topic, each topic at most 8 KB (example topics 12 KB), every string at most 2000 characters and
// every container at most 6 deep in the reply, as the app hands them to the model.
// This is the skeleton: `guide` (the CAD notes themselves), `errors` (every reason with its fix),
// `features` (each tool's fields), `parameters` and `selectors` (every form of the selector
// language) are filled, `checks` starts with how to read measure's numbers; the topics whose
// tools come later say so, and are filled with them.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { FUNCTION_NAMES, UNIT_NAMES } from '../doc/expr';
import { MAX_PARAM_NAME } from '../doc/params';
import { HINTS, REASONS, type ToolCode } from './errors';
import { GUIDE } from './guide';
import { CAD_TOOLS, HELP_TOPICS, type HelpTopic } from './schemas';

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
  for (const sub of ['no_overlap', 'wrong_side', 'off_body'] as const) rows.push({ about: `${sub} (detail.sub)`, text: HINTS[sub] });
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
    text: `FEATURE.ROLE: Base.start, Base.end, Base.side (all its sides), Base.side(l2) (the side swept from sketch entity l2; macro parts as r.top, p.3), Base.end(2) (the second profile's cap), Pipe.side(o@a2) (a sweep side: profile entity @ path entity), Fillet 1.fillet(1), Shell 1.inner(Base.end), Row.copy(2) (a pattern copy), Flip.mirror, Split 1.cut. Roles: start, end, side, cut, inner, fillet, chamfer, copy, mirror, import, heal, enclosure. A face merged by a join has every part's label.`,
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

export const HELP: Readonly<Record<HelpTopic, readonly HelpRow[]>> = Object.freeze({
  sketch: later('The sketch reference (entity kinds, macros and their parts, relations and dimensions with their refs)'),
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
