// The help tool's fixed reference (CAD tools spec §10.2): JSON rows {about, text, example?} per
// topic, each topic at most 8 KB (example topics 12 KB), every string at most 2000 characters and
// every container at most 6 deep in the reply, as the app hands them to the model.
// This is the skeleton: `guide` (the CAD notes themselves), `errors` (every reason with its fix),
// `features` (each tool's fields) and `parameters` are filled; the topics whose tools come later
// say so, and are filled with them.
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

const later = (what: string): HelpRow[] => [{ about: 'not in this build yet', text: `${what} comes with the tools it describes. Until then each tool's own description says what its fields take.` }];

export const HELP: Readonly<Record<HelpTopic, readonly HelpRow[]>> = Object.freeze({
  sketch: later('The sketch reference (entity kinds, macros and their parts, relations and dimensions with their refs)'),
  selectors: later('The selector reference (every form with examples)'),
  features: featureRows(),
  parameters: parameterRows(),
  checks: later('The list of checks'),
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
