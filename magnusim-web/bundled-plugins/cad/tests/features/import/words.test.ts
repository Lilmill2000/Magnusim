// The import panel's words: each step of an import as it runs (upload percent,
// then the kernel's seconds), the diagnostics line, and short times read in ms
// (the reopened flange said "Loaded ... in 0.0 s").
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { diagnosticsLine, msWords, stageWords } from '../../../src/features/import/panel';
import type { ImportFeature } from '../../../src/types/doc';

describe('import panel words', () => {
  it('says each step', () => {
    const now = 20_000;
    expect(stageWords({ stage: 'hashing', since: 0 }, 'flange.step', now)).toBe('Checking flange.step');
    expect(stageWords({ stage: 'uploading', done: 45, total: 100, since: 0 }, 'flange.step', now)).toBe('Uploading flange.step · 45%');
    expect(stageWords({ stage: 'reading', since: 7_600 }, '8m0119333_V12.step', now)).toBe('Reading 8m0119333_V12.step · 12 s');
    expect(stageWords({ stage: 'healing', since: 17_000 }, 'a.step', now)).toBe('Healing · 3 s');
    expect(stageWords({ stage: 'storing', done: 1, total: 4, since: 0 }, 'a.step', now)).toBe('Storing the healed shapes · 25%');
  });

  it('the diagnostics line', () => {
    const f = (d: ImportFeature['diagnostics']) => ({ diagnostics: d }) as ImportFeature;
    expect(diagnosticsLine(f({ problemsBefore: 0, problemsAfter: 0, fixed: 0 }), false)).toBe('0 problems');
    expect(diagnosticsLine(f({ problemsBefore: 3, problemsAfter: 0, fixed: 1 }), false)).toBe('3 problems found · 0 left after healing');
    expect(diagnosticsLine(f({ problemsBefore: 1, problemsAfter: 1, fixed: 0 }), true)).toBe('1 problem');
    // Review P2/P3 round 1: "0 problems" above "6 faces not in a solid".
    expect(diagnosticsLine(f({ problemsBefore: 0, problemsAfter: 0, fixed: 1, freeEdges: 8 }), false, true)).toBe('0 problems · not a closed solid');
  });

  it('a time under a second reads in ms', () => {
    expect(msWords(0.4)).toBe('1 ms');
    expect(msWords(31.6)).toBe('32 ms');
    expect(msWords(1234)).toBe('1.2 s');
  });
});
