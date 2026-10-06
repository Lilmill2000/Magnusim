import { describe, expect, it } from 'vitest';
import { carrySettle } from './runSettle';

// F5: "Copy from previous run" and "Add run" carry the run's "Stop when settled".
const SETTLE = { source: 'monitor', id: 'rc-1', quantity: 'Cd', tolerance: 0.001, window: 100 };
const SRC = { settle: SETTLE, result_controls: [{ id: 'rc-0' }, { id: 'rc-1' }] };
const base = { copiedControls: [{ id: 'rc-new0' }, { id: 'rc-new1' }], otherStudy: false, srcTransient: false, destTransient: false, studyBcIds: ['bc-in'] };

describe('carrySettle', () => {
  it('follows its monitor to the copy (the same place in the cloned list)', () => {
    expect(carrySettle(SRC, base)).toEqual({ settle: { ...SETTLE, id: 'rc-new1' }, note: '' });
  });

  it('keeps a boundary of the same study', () => {
    const src = { settle: { ...SETTLE, source: 'boundary', id: 'bc-in', quantity: 'Q' } };
    expect(carrySettle(src, base).settle).toEqual(src.settle);
    expect(carrySettle(src, { ...base, studyBcIds: [] })).toEqual({
      settle: null,
      note: 'Its "Stop when settled" is off here: the boundary it watched is not in this study.',
    });
  });

  it('is off, with a note, when its monitor does not come across', () => {
    expect(carrySettle(SRC, { ...base, otherStudy: true, copiedControls: [] }).note).toBe(
      'Its "Stop when settled" is off here: the monitor it watched stays with the other study.',
    );
    expect(carrySettle({ ...SRC, result_controls: [{ id: 'rc-0' }] }, base).note).toBe(
      'Its "Stop when settled" is off here: the monitor it watched is gone.',
    );
    expect(carrySettle(SRC, { ...base, copiedControls: [{ id: 'rc-new0' }] }).settle).toBeNull();
  });

  it('is off for a run of the other time dependency (its window is in other units)', () => {
    expect(carrySettle(SRC, { ...base, destTransient: true })).toEqual({
      settle: null,
      note: 'Its "Stop when settled" is off here: it was set for a steady run.',
    });
  });

  it('a source without one gives none and no note', () => {
    expect(carrySettle({ result_controls: [] }, base)).toEqual({ settle: null, note: '' });
    expect(carrySettle(null, base)).toEqual({ settle: null, note: '' });
  });
});
