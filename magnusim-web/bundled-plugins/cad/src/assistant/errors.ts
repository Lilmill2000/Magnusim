// The Assistant tools' honest errors (CAD tools spec §3.3): every refusal or failure is a
// ToolError with a fixed reason, the code the app keeps for it, a message that starts with the
// reason (still useful on a host that keeps only the message), one fixed hint per reason (the
// same text help errors gives) and a plain-JSON detail the model can act on.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The codes the app keeps for a page's tool error. */
export type ToolCode = 'invalid_input' | 'failed' | 'busy' | 'not_ready';

/** Every reason, by its code. A sub-reason (detail.sub) has a hint of its own too. */
export const REASONS = {
  invalid_input: [
    'bad_input',
    'bad_id',
    'bad_entity',
    'bad_ref',
    'bad_selector',
    'selector_index',
    'unknown_role',
    'nothing_selected',
    'selector_ambiguous',
    'selector_stale',
    'ambiguous_name',
    'not_found',
    'wrong_feature_type',
    'name_taken',
    'bad_name',
    'expr_error',
    'incomplete',
    'self_reference',
    'later_feature',
    'not_flat',
    'region_not_found',
    'open_profile',
    'sketch_conflict',
    'sketch_collapsed',
    'unsupported_sketch',
    'too_big',
    'bad_section',
    'in_use',
    'not_own_step',
    'nothing_to_undo',
    'not_asked',
    'key_taken',
  ],
  failed: ['feature_failed', 'broke_downstream', 'cut_removed_nothing', 'sketch_unsolved', 'not_named', 'kernel_failed', 'rebuild_timeout', 'internal', 'link_failed'],
  busy: ['person_editing', 'rolled_back', 'paused', 'taken_over', 'step_declined', 'stopped', 'other_turn', 'changed', 'view_latched'],
  not_ready: ['loading', 'not_editable', 'opening_geometry', 'kernel_starting', 'solver_starting', 'no_viewport', 'no_images', 'small_context', 'not_built', 'no_link'],
} as const;

export type Reason = (typeof REASONS)[ToolCode][number];
/** The sub-reasons of feature_failed and cut_removed_nothing (detail.sub). */
export type SubReason = 'no_overlap' | 'wrong_side' | 'too_short' | 'off_body';

/** Each reason's code. */
export const REASON_CODE: Readonly<Record<Reason, ToolCode>> = Object.freeze(
  Object.fromEntries((Object.entries(REASONS) as [ToolCode, readonly Reason[]][]).flatMap(([code, list]) => list.map((r) => [r, code]))) as Record<Reason, ToolCode>,
);

/** One fixed sentence per reason and sub-reason: how to fix it (help errors lists the same). */
export const HINTS: Readonly<Record<Reason | SubReason, string>> = Object.freeze({
  bad_input: 'Fix the fields the message names and call again.',
  bad_id: 'Ids are a-z, 0-9 and _ (a letter first, no double _), unique, and never origin.',
  bad_entity: 'Give the entity kind the numbers its at needs (help sketch).',
  bad_ref: 'Use refs that fit the signatures the message lists, or read help sketch.',
  bad_selector: 'Fix the selector at the column given, or try it with find first (help selectors).',
  selector_index: 'Use an index inside detail.range.',
  unknown_role: 'Use a role the feature has: find lists the faces it made.',
  nothing_selected: 'Nothing matched: read detail.candidates, or call find to see what exists.',
  selector_ambiguous: 'Narrow it to one of detail.candidates: a handle, a label or a point.',
  selector_stale: 'That handle is gone after a change: call find again.',
  ambiguous_name: 'Use a form that names one thing only, or its handle.',
  not_found: 'Use one of the names listed; get_model lists them all.',
  wrong_feature_type: 'Change it with the tool of its own type, or with edit_feature.',
  name_taken: 'Pick another name, or pass edit with that name to replace it.',
  bad_name: 'A name is a letter or _ followed by letters, digits or _, and not a unit or function name.',
  expr_error: 'Fix the expression: write units, and use only parameters that exist (help parameters).',
  incomplete: 'Give what the message asks for and call again.',
  self_reference: 'A feature cannot use itself: pick geometry made before it.',
  later_feature: 'Pick geometry made before this feature in the history.',
  not_flat: 'Pick one flat face, a construction plane, or Top, Front or Right.',
  region_not_found: 'Use one of the regions detail lists, or at(u, v) inside the one you want.',
  open_profile: 'Close the profile: join the open ends the message lists (help sketch).',
  sketch_conflict: 'Remove one of your named constraints; never add it back.',
  sketch_collapsed: 'Give the named entity a size above zero, or remove what shrinks it.',
  unsupported_sketch: 'The sketch tool cannot write this sketch: change its dimension values with edit_feature.',
  too_big: 'Split the work: use edit_feature for its dimensions, or make a second sketch.',
  bad_section: 'A section takes one body and a plane; leave section "" otherwise.',
  in_use: 'Change or delete what uses it first: detail lists them.',
  not_own_step: 'The person changed the Part after your step: leave it, or ask the person.',
  nothing_to_undo: 'None of your steps in this request is left to undo.',
  not_asked: "Only change keybinds when the person explicitly asked for that change in this request; otherwise tell them how to do it themselves (keybind_get's set_in says where, per command).",
  key_taken: 'Another command has that key (detail.with): ask the person, then call again with items ["replace"] to take it, or pick another key.',
  feature_failed: 'Read detail.message and detail.sub, change the inputs and call again.',
  broke_downstream: 'Nothing changed: pick a value that keeps the features in detail.broke working.',
  cut_removed_nothing: 'The cut missed: read detail.sub, then flip it or move the profile.',
  sketch_unsolved: 'The solver found no solution: draw closer to the shape you mean, or remove a dimension.',
  not_named: 'That geometry has no stable name: pick it by a point (face at (x, y, z)) or a handle.',
  kernel_failed: 'The geometry kernel failed: call get_model, then try a simpler input.',
  rebuild_timeout: 'The rebuild took too long: call get_model, then try a simpler input.',
  internal: 'Something went wrong in the CAD workspace: call get_model, and tell the person if it happens again.',
  link_failed: 'The project refused the update: tell the person the reason in the message; fix what it names, then send again.',
  person_editing: 'The call already waited 10 minutes for the person: say what you need and end your turn.',
  rolled_back: 'The rollback bar is not at the end: ask the person to move it to the end, and end your turn.',
  paused: 'The person paused the Assistant: say what you would do next and end your turn.',
  taken_over: 'The person took over: do not repeat the step; ask what they want and end your turn.',
  step_declined: 'The person declined this step: ask what to change.',
  stopped: 'The person stopped the Assistant in this Part: end your turn now.',
  other_turn: 'Another request is working in this Part: end your turn.',
  changed: 'The Part changed while the call ran: call get_model, then try again.',
  view_latched: "The person moved their view in this request: leave it, or ask them and call again with person_asked true.",
  loading: 'The Part is still opening: call get_model again in a moment.',
  not_editable: 'Tell the person what blocks editing (the message says it), and end your turn.',
  opening_geometry: 'The Part is still opening its project geometry: try again in a moment.',
  kernel_starting: 'The geometry kernel is still starting: try again in a moment.',
  solver_starting: 'The sketch solver is still starting: try again in a moment.',
  no_viewport: 'Pictures need the viewport: use measure and find instead.',
  no_images: "The model can't read images here: use measure and find.",
  small_context: 'Load the local model with a longer context (at least 24,000 tokens) in the local server, or start a new conversation.',
  not_built: 'This tool is not in this build yet: use the tools that answer, and tell the person what is missing.',
  no_link: 'This Magnusim cannot link the Part into the project: tell the person to update Magnusim.',
  no_overlap: 'A join needs to overlap the body or share a face with it: move the profile onto the body, or use op new and then combine.',
  wrong_side: 'The cut points away from the body: set flip true, or use hole.',
  too_short: 'The cut stops before it reaches the body: make distance (or angle) larger, or use extent through (a revolve: full).',
  off_body: 'The profile lies beside the body: read detail.frame (where u and v point in model axes) and move the profile.',
});

export interface ToolErrorOptions {
  /** Replaces the reason's (or the sub-reason's) fixed hint. */
  hint?: string;
  /** Plain JSON beside detail.reason: candidates, conflicts, broke, field, kept, frame, range, sub, ... */
  detail?: Record<string, unknown>;
}

/**
 * A tool's refusal or failure. `message` reads "<reason>: <what happened>"; `detail.reason` is the
 * reason; `hint` is the sub-reason's fixed hint when detail.sub names one, else the reason's.
 */
export class ToolError extends Error {
  readonly reason: Reason;
  readonly code: ToolCode;
  readonly hint: string;
  readonly detail: Record<string, unknown>;

  constructor(reason: Reason, message: string, opts: ToolErrorOptions = {}) {
    super(`${reason}: ${message}`);
    this.name = 'ToolError';
    this.reason = reason;
    this.code = REASON_CODE[reason];
    const sub = opts.detail?.sub;
    this.hint = opts.hint ?? (typeof sub === 'string' && sub in HINTS ? HINTS[sub as SubReason] : HINTS[reason]);
    this.detail = { reason, ...(opts.detail ?? {}) };
  }
}

export const isToolError = (e: unknown): e is ToolError => e instanceof ToolError;

/**
 * What the handler throws to the SDK: `{code, message, hint, detail}`. A host that keeps only the
 * message (no `hint` on a call's error) gets the hint in it ("... Try: <hint>").
 */
export function sdkError(e: ToolError, hostKeepsHints: boolean): Error & { code: ToolCode; hint?: string; detail?: Record<string, unknown> } {
  const message = hostKeepsHints ? e.message : `${e.message} Try: ${e.hint}`;
  const out = new Error(message) as Error & { code: ToolCode; hint?: string; detail?: Record<string, unknown> };
  out.code = e.code;
  if (hostKeepsHints) {
    out.hint = e.hint;
    out.detail = e.detail;
  }
  return out;
}

/** Any throw as a ToolError: a ToolError as it is, anything else `internal` with its words. */
export function asToolError(e: unknown): ToolError {
  if (isToolError(e)) return e;
  const words = e instanceof Error ? e.message : String(e ?? 'unknown');
  return new ToolError('internal', words || 'unknown');
}
