import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTransient } from '../w30-transient.js';

describe('normalizeTransient max_co', () => {
  it('keeps the Courant number the user set', () => {
    assert.equal(normalizeTransient({ max_co: 200 }).max_co, 200);
    assert.equal(normalizeTransient({ max_co: 0.25 }).max_co, 0.25);
  });

  it('rejects non-positive Courant numbers', () => {
    const t = normalizeTransient({ max_co: 0 }, { max_co: 1 });
    assert.equal(t.max_co, 1);
  });
});
