import { describe, expect, it } from 'vitest';
import { answerStillCurrent, resultsDrawAllowed, sameCaseDir } from './resultsDisplay';

// A run's result drawings belong to an open Results view (Daniel, 2026-11-03: a steady
// run's trace stayed on another study's solving run).
describe('resultsDrawAllowed', () => {
  it('allows result drawings only while a Results view is open and the mesh view is not', () => {
    expect(resultsDrawAllowed({ resultsViewOpen: true, meshInspectOpen: false })).toBe(true);
    expect(resultsDrawAllowed({ resultsViewOpen: false, meshInspectOpen: false })).toBe(false);
    expect(resultsDrawAllowed({ resultsViewOpen: false, meshInspectOpen: true })).toBe(false);
    expect(resultsDrawAllowed({ resultsViewOpen: true, meshInspectOpen: true })).toBe(false);
  });
});

describe('sameCaseDir', () => {
  it('reads one folder whatever its slashes, letter case or trailing slash', () => {
    expect(sameCaseDir('C:\\P\\runs\\run_1\\case', 'c:/p/runs/run_1/case/')).toBe(true);
    expect(sameCaseDir('C:/P/runs/run_1/case', 'C:/P/runs/run_2/case')).toBe(false);
    expect(sameCaseDir('', null)).toBe(true);
    expect(sameCaseDir('C:/P/case', '')).toBe(false);
  });
});

describe('answerStillCurrent', () => {
  const asked = { gen: 4, caseDir: 'C:/P/runs/run_1/case', time: '100' };
  const now = { ...asked, resultsViewOpen: true, meshInspectOpen: false };

  it('lets an answer draw when the same Results, case and time still show', () => {
    expect(answerStillCurrent(asked, now)).toBe(true);
    expect(answerStillCurrent(asked, { ...now, caseDir: 'c:\\p\\runs\\run_1\\case' })).toBe(true);
  });

  it('drops it once Results closed or the mesh view opened', () => {
    expect(answerStillCurrent(asked, { ...now, resultsViewOpen: false })).toBe(false);
    expect(answerStillCurrent(asked, { ...now, meshInspectOpen: true })).toBe(false);
  });

  it('drops it once the drawings were taken away since (left and back, another run opened)', () => {
    expect(answerStillCurrent(asked, { ...now, gen: 5 })).toBe(false);
  });

  it("drops another case's answer (a run switched to inside Results)", () => {
    expect(answerStillCurrent(asked, { ...now, caseDir: 'C:/P/runs/run_2/case' })).toBe(false);
  });

  it('drops an answer for a time the view has left', () => {
    expect(answerStillCurrent(asked, { ...now, time: '50' })).toBe(false);
  });
});
