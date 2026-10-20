// The review rounds the Part asks the app for (src/assistant/review.ts): within the app's limits
// (1 to 5 rounds, a prompt of at most 1500 characters), ASCII and vendor-neutral, and every view
// input it names is one the view tool takes (the directions, the section "Front middle", labels).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CAD_REVIEW, REVIEW_PROMPT, REVIEW_ROUNDS } from '../../src/assistant/review';
import { VIEW_DIRECTIONS } from '../../src/assistant/schemas';
import { parseSection, readViewInput } from '../../src/assistant/view';
import { namesVendor } from './vendor';

describe('the review the Part asks for', () => {
  it('is within the app limits, ASCII and vendor-neutral', () => {
    expect(CAD_REVIEW).toEqual({ rounds: REVIEW_ROUNDS, prompt: REVIEW_PROMPT });
    expect(REVIEW_ROUNDS).toBe(3);
    expect(REVIEW_PROMPT.length).toBeLessThanOrEqual(1500);
    expect(REVIEW_PROMPT).toMatch(/^[\x20-\x7e\n]+$/);
    expect(namesVendor(REVIEW_PROMPT)).toBe(false);
    expect(REVIEW_PROMPT).toContain("reply 'Review: no changes' without calling any edit tool");
    expect(REVIEW_PROMPT).toContain('reference picture');
  });

  it('names only view inputs the tool takes', () => {
    for (const d of ['iso', 'top', 'front']) expect(VIEW_DIRECTIONS).toContain(d);
    expect(() => readViewInput({ views: ['iso', 'top', 'front'], hide: [], section: '', labels: 'bodies', size: 'small' })).not.toThrow();
    const section = /section "([^"]+)"/.exec(REVIEW_PROMPT)![1];
    expect(section).toBe('Front middle');
    expect(parseSection(section, () => ({ ok: false, error: 'no expressions here' }))).toEqual({ plane: 'front', offset: 0, flip: false, middle: true });
  });
});
