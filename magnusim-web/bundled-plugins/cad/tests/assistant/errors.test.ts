// @vitest-environment node
// The tools' honest errors (CAD tools spec §3.3): every reason has its code and one fixed hint;
// a ToolError's message starts with its reason and its detail names it; a sub-reason's hint
// wins; what the SDK gets (hint and detail on a host that keeps them, else the hint in the
// message); and the help errors topic lists the same.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { asToolError, HINTS, REASON_CODE, REASONS, sdkError, ToolError } from '../../src/assistant/errors';
import { HELP } from '../../src/assistant/help';
import { namesVendor } from './vendor';

describe('reasons and codes', () => {
  it('every reason of the spec has its code and one hint sentence', () => {
    expect(REASONS.not_ready).toContain('not_built');
    expect(REASONS.busy).toEqual(['person_editing', 'rolled_back', 'paused', 'taken_over', 'step_declined', 'stopped', 'other_turn', 'changed']);
    for (const [code, list] of Object.entries(REASONS)) for (const r of list) expect(REASON_CODE[r], r).toBe(code);
    for (const r of [...Object.values(REASONS).flat(), 'no_overlap', 'wrong_side', 'off_body'] as (keyof typeof HINTS)[]) {
      expect(HINTS[r], r).toMatch(/^[A-Z][^\n]*[.:?]$/);
      expect(HINTS[r].length, r).toBeLessThanOrEqual(500);
      expect(namesVendor(HINTS[r]), r).toBe(false);
    }
    expect(HINTS.wrong_side).toBe('The cut points away from the body: set flip true, or use hole.');
    expect(HINTS.person_editing).toBe('The call already waited 10 minutes for the person: say what you need and end your turn.');
  });

  it('a ToolError reads "<reason>: ...", names its reason in detail, and takes a sub-reason\'s hint', () => {
    const e = new ToolError('not_found', 'No feature is called "Boss".', { detail: { names: ['Plate'] } });
    expect(e.message).toBe('not_found: No feature is called "Boss".');
    expect(e.code).toBe('invalid_input');
    expect(e.detail).toEqual({ reason: 'not_found', names: ['Plate'] });
    expect(e.hint).toBe(HINTS.not_found);
    const miss = new ToolError('feature_failed', 'Nothing to cut.', { detail: { sub: 'wrong_side' } });
    expect(miss.code).toBe('failed');
    expect(miss.hint).toBe(HINTS.wrong_side);
    expect(new ToolError('bad_input', 'x', { hint: 'Do this.' }).hint).toBe('Do this.');
  });

  it('what the SDK gets: code, message, hint and detail; on a host that keeps only the message, the hint in it', () => {
    const e = new ToolError('not_built', 'view is not in this build yet.');
    const full = sdkError(e, true);
    expect(full).toMatchObject({ code: 'not_ready', message: 'not_built: view is not in this build yet.', hint: HINTS.not_built, detail: { reason: 'not_built' } });
    const bare = sdkError(e, false);
    expect(bare.message).toBe(`not_built: view is not in this build yet. Try: ${HINTS.not_built}`);
    expect(bare.hint).toBeUndefined();
    expect(bare.detail).toBeUndefined();
    // Anything else thrown is internal, with its words.
    expect(asToolError(new Error('boom'))).toMatchObject({ reason: 'internal', code: 'failed', message: 'internal: boom' });
    expect(asToolError(e)).toBe(e);
  });

  it('help errors lists every reason with the same hint', () => {
    const rows = HELP.errors;
    for (const [code, list] of Object.entries(REASONS)) for (const r of list) expect(rows).toContainEqual({ about: `${r} (${code})`, text: HINTS[r] });
    expect(rows).toContainEqual({ about: 'off_body (detail.sub)', text: HINTS.off_body });
  });
});
