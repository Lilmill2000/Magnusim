import { describe, expect, it } from 'vitest';
import shared from '../tests/transient_vectors.json';
import { normalizeTransient, transientHint } from './transient';

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

// RH2: the hint reads the run's pre-run check: its estimate's steps and flow-through time in
// place of the preview's rough count, and its long_run row's words as the warning ("That is a
// long run" is gone).
describe('transient hint: the pre-run check', () => {
  const t = normalizeTransient({ end_time: 10, write_count: 60, max_co: 100 }, {}, shared.defaults);
  const pv = { ok: true, control: { adjust_time_step: true, delta_t: 1.3e-5, max_co: 100, source: { delta_t: 'auto' }, estimate: { steps: 10500, flow_through_s: 0.1 } } };
  it('without a check: the preview estimate, no long-run warning', () => {
    const h = transientHint(t, pv as never, null);
    expect(h.text).toContain('roughly 10,500 time steps');
    expect(h.warn).toBe('');
  });
  it("with one: its steps and flow-through, and its long_run row's words", () => {
    const h = transientHint(t, pv as never, {
      estimate: { steps: 900000, flow_through_s: 0.177 },
      checks: [{ code: 'long_run', text: 'About 900,000 time steps, roughly 6 days on 15 cores (this PC\u2019s last runs).' }],
    });
    expect(h.text).toContain('roughly 900,000 time steps');
    expect(h.text).toContain('one flow-through of the domain ≈ 0.177 s');
    expect(h.warn).toBe('About 900,000 time steps, roughly 6 days on 15 cores (this PC\u2019s last runs).');
    expect(h.warn).not.toMatch(/That is a long run/);
  });
});
