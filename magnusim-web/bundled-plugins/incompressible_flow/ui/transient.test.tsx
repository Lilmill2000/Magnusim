import { describe, expect, it } from 'vitest';
import shared from '../tests/transient_vectors.json';
import { normalizeTransient } from './transient';

// The Run panel cleans transient settings as the user types; the analysis
// cleans them again when it stores them (normalize_transient). The two used to
// differ (10000 frames showed, 5000 were stored). tests/test_transient.py
// checks the Python side against the same file.
describe('transient settings: the panel and the analysis agree', () => {
  for (const v of shared.vectors) {
    it(v.name, () => {
      const got = normalizeTransient(v.raw as Record<string, unknown>, v.base as Record<string, unknown>, shared.defaults);
      const want = { ...shared.defaults, ...v.base, ...v.expected };
      for (const [k, value] of Object.entries(want)) {
        if (typeof value === 'number') expect(got[k], k).toBeCloseTo(value, 12);
        else expect(got[k], k).toEqual(value);
      }
    });
  }
});
