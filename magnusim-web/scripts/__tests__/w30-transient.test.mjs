import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as w30 from '../w30-transient.js';

const here = dirname(fileURLToPath(import.meta.url));
const text = (rel) => readFileSync(join(here, '..', rel), 'utf8');

describe('transient runs on the server', () => {
  it('tells transient studies and runs apart', () => {
    assert.equal(w30.isTransientLabel('Transient'), true);
    assert.equal(w30.isTransientLabel('Steady-state'), false);
    assert.equal(w30.simIsTransient({ time_dependency: 'Transient' }), true);
    assert.equal(w30.simIsTransient(null), false);
  });

  // A transient run's settings are its analysis's: the plugin's run model
  // cleans every save (analysis.run_normalize), so Node keeps no limits.
  it('keeps no copy of the run settings or their limits', () => {
    assert.equal('normalizeTransient' in w30, false);
    assert.equal('TRANSIENT_DEFAULTS' in w30, false);
    const src = text('w30-transient.js');
    assert.equal(/max_co|n_correctors|write_count|Math\.(min|max)\(/.test(src), false);
    const w27 = text('w27-solve.js');
    assert.equal(w27.includes('normalizeTransient('), false);
    assert.match(w27, /'analysis\.run_normalize'/);
  });
});
