import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeStudyOrder } from '../w17-sim-catalog.js';

// The walked catalog lists every id.json field, undefined when the folder does not
// record it. Those blanks used to overwrite the saved study (turbulence model, physics).
test('study catalog merge keeps saved fields the study folder does not record', () => {
  const walked = [
    { id: 'sim_1', name: 'Study', dir: '/p/s', folder: 'Study', turbulence_model: undefined, analysis_type: undefined },
  ];
  const saved = [
    { id: 'sim_1', name: 'Old name', turbulence_model: 'kEpsilon', analysis_type: 'incompressible_steady', residual_u: 2e-5 },
  ];
  const [row] = mergeStudyOrder(walked, saved);
  assert.equal(row.turbulence_model, 'kEpsilon');
  assert.equal(row.analysis_type, 'incompressible_steady');
  assert.equal(row.residual_u, 2e-5);
  // A value the folder does record still wins.
  assert.equal(row.name, 'Study');
  assert.equal(row.dir, '/p/s');
});
