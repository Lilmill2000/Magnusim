import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldSolveEvent, newSolveFold, regionSeries, regionsOf } from '../solve-fold.js';
import { compactResidual, parseSolveProgress } from '../w27-solve.js';

// HT3: a multi-region run's residuals are keyed <region>:<field> by its log parser
// (magnusim_sdk.progress.RegionProgressParser). Node keeps them, and plots an
// analysis's declared series once per region.

const SERIES = [
  { key: 'U', fields: ['Ux', 'Uy', 'Uz'] },
  { key: 'h' },
  { key: 'co_mean', dashed: true, max_key: 'co_max' },
];

describe('residuals of a multi-region run', () => {
  it('reads the regions of a row', () => {
    assert.deepEqual(regionsOf({ t: 1, 'air:Ux': 1, 'air:h': 1, 'heater:h': 2, co_max: 1 }), ['air', 'heater']);
    assert.deepEqual(regionsOf({ t: 1, Ux: 1 }), []);
  });

  it('expands the declared series per region; dashed metrics stay once', () => {
    assert.equal(regionSeries(SERIES, []), SERIES);
    assert.deepEqual(
      regionSeries(SERIES, ['air', 'heater']).map((s) => [s.key, s.region || '', (s.fields || []).join()]),
      [
        ['air:U', 'air', 'air:Ux,air:Uy,air:Uz'],
        ['air:h', 'air', 'air:h'],
        ['heater:U', 'heater', 'heater:Ux,heater:Uy,heater:Uz'],
        ['heater:h', 'heater', 'heater:h'],
        ['co_mean', '', ''],
      ],
    );
  });

  it('a step keeps region keys', () => {
    const fold = newSolveFold();
    foldSolveEvent(fold, { event: 'progress', time: 1 });
    foldSolveEvent(fold, { event: 'residual', field: 'air:h', initial: 0.5 });
    foldSolveEvent(fold, { event: 'residual', field: 'heater:h', initial: 0.25 });
    foldSolveEvent(fold, { event: 'residual', field: 'a:b:c', initial: 9 });
    assert.deepEqual(fold.current, { t: 1, 'air:h': 0.5, 'heater:h': 0.25 });
  });

  it('compacts a region row per region', () => {
    const row = { t: 2, 'air:Ux': 0.1, 'air:Uy': 0.3, 'air:h': 0.05, 'heater:h': 0.02, co_mean: 0.2, co_max: 0.7 };
    assert.deepEqual(compactResidual(row, SERIES), { t: 2, 'air:U': 0.3, 'air:h': 0.05, 'heater:h': 0.02, co_mean: 0.2, co_max: 0.7 });
  });

  it('a run log read back keeps every region step', () => {
    const log = [
      { event: 'stage', stage: 'solve' },
      { event: 'progress', time: 1 },
      { event: 'residual', field: 'air:Ux', initial: 1 },
      { event: 'residual', field: 'air:h', initial: 0.9 },
      { event: 'residual', field: 'heater:h', initial: 0.4 },
      { event: 'progress', time: 2 },
      { event: 'residual', field: 'air:Ux', initial: 0.5 },
      { event: 'residual', field: 'air:h', initial: 0.3 },
      { event: 'residual', field: 'heater:h', initial: 0.1 },
    ]
      .map((e) => `MAGNUSIM_EVENT ${JSON.stringify(e)}`)
      .join('\n');
    // An analysis key the registry does not know: no declared series, every number as it came.
    const snap = parseSolveProgress(log, 'no_such_analysis');
    assert.deepEqual(snap.residuals, [
      { t: 1, 'air:Ux': 1, 'air:h': 0.9, 'heater:h': 0.4 },
      { t: 2, 'air:Ux': 0.5, 'air:h': 0.3, 'heater:h': 0.1 },
    ]);
  });
});
