// The review rounds the Part asks the app for (src/assistant/review.ts): within the app's limits
// (1 to 5 rounds, a prompt of at most 1500 characters), ASCII and vendor-neutral, and every view
// input it names is one the view tool takes (the directions, the section "Front middle", labels);
// it asks whether every part the request named exists, whether each moving part is held radially
// and along its shaft, whether anything collides when it turns and whether every part can be
// printed, naming check kinds, get_model's parts and a help topic that exist.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CAD_REVIEW, REVIEW_PROMPT, REVIEW_ROUNDS } from '../../src/assistant/review';
import { CHECK_KINDS, HELP_TOPICS, toolNamed, VIEW_DIRECTIONS } from '../../src/assistant/schemas';
import { readViewInput } from '../../src/assistant/view';
import { splitSection } from '../../src/assistant/measure-targets';
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

  it('asks about the parts, how each moving part is held, collisions when it turns, and printing, by checks that exist', () => {
    expect(REVIEW_PROMPT).toContain('every part the request named exists (get_model parts)');
    expect(REVIEW_PROMPT).toContain('held radially (a shaft in its bore) and along its shaft on both sides (check stack)');
    expect(REVIEW_PROMPT).toContain('collide when it turns (check sweep, check interference)');
    expect(REVIEW_PROMPT).toContain('can every part be printed (help printing');
    for (const k of ['stack', 'sweep', 'interference']) expect(CHECK_KINDS).toContain(k);
    expect(HELP_TOPICS).toContain('printing');
    expect(toolNamed('check')?.risk).toBe('read');
    expect(toolNamed('get_model')?.description).toContain('parts (every body in one short row)');
  });

  it('names only view inputs the tool takes', () => {
    for (const d of ['iso', 'top', 'front']) expect(VIEW_DIRECTIONS).toContain(d);
    expect(() => readViewInput({ views: ['iso', 'top', 'front'], hide: [], section: '', labels: 'bodies', size: 'small' })).not.toThrow();
    const section = /section "([^"]+)"/.exec(REVIEW_PROMPT)![1];
    expect(section).toBe('Front middle');
    expect(splitSection(section)).toEqual({ base: 'Front', offset: null, middle: true, flip: false });
  });
});
