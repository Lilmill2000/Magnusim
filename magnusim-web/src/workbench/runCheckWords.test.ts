import { describe, expect, it } from 'vitest';
import {
  altLabel,
  applyAllFixes,
  applyAllTitle,
  applyLabel,
  checkedAtStartLine,
  countWords,
  noneFoundWords,
  orderedRows,
  partialWords,
  precheckCost,
  splitKept,
  startTitle,
  startedWithWords,
  wallWords,
  withPrecheckCosts,
  type CheckRow,
} from './runCheckWords';

const PISO: CheckRow = {
  code: 'piso_high_co',
  level: 'warn',
  text: 'Max Courant 100 with 1 outer corrector.',
  short: 'Max Courant 100 with PISO',
  fix: { label: '3 outer correctors, Max Courant 5', target: 'run', values: [{ key: 'transient.n_outer_correctors', value: 3 }, { key: 'transient.max_co', value: 5 }], cost: { steps: 180000, wall_s: 315000 } },
  alt: { label: 'Max Courant 1', target: 'run', values: [{ key: 'transient.max_co', value: 1 }], cost: { steps: 900000, wall_s: 525000 } },
};
const STILL: CheckRow = { code: 'still_start', level: 'info', text: 'The run starts from rest.', short: 'starts from rest', fix: { label: 'Start from potential flow', target: 'study', values: [{ key: 'potential_flow', value: true }] } };
const MESH: CheckRow = { code: 'mesh_failed', level: 'error', text: 'checkMesh failed 1 check.', short: 'checkMesh failed 1 check', fix: { label: 'Open mesh', target: 'mesh', values: [] } };

describe('the pre-run check words (RH2)', () => {
  it('orders problems, warnings, notes and splits what is kept as set', () => {
    expect(orderedRows([STILL, PISO, MESH]).map((r) => r.code)).toEqual(['mesh_failed', 'piso_high_co', 'still_start']);
    const s = splitKept([STILL, PISO, MESH], ['piso_high_co']);
    expect(s.open.map((r) => r.code)).toEqual(['mesh_failed', 'still_start']);
    expect(s.kept.map((r) => r.code)).toEqual(['piso_high_co']);
  });

  it("Apply's words and the alternative's cost", () => {
    expect(applyLabel(PISO.fix!)).toBe('Use 3 outer correctors, Max Courant 5');
    expect(applyLabel(STILL.fix!)).toBe('Use Start from potential flow');
    expect(applyLabel(MESH.fix!)).toBe('Open mesh');
    expect(altLabel(PISO.alt!)).toBe('Max Courant 1 (about 6 days)');
    expect(wallWords(900)).toBe('about 15 minutes');
    expect(wallWords(6 * 3600)).toBe('about 6 hours');
  });

  it("Start's title counts the problems and warnings as Checked at start will, kept ones saying so; none blocks it", () => {
    expect(startTitle([PISO, STILL])).toBe('Starts with 1 warning (see Before you start)');
    expect(startTitle([PISO, MESH])).toBe('Starts with 1 problem and 1 warning (see Before you start)');
    expect(startTitle([{ ...PISO, kept: true }, STILL])).toBe('Starts with 1 warning, 1 kept as set (see Before you start)');
    expect(startTitle([{ ...PISO, kept: true }, { ...PISO, code: 'long_run' }])).toBe('Starts with 2 warnings, 1 kept as set (see Before you start)');
    expect(checkedAtStartLine([{ ...PISO, kept: true }, { ...PISO, code: 'long_run' }])).toMatch(/^Checked at start: 2 warnings /);
    expect(startTitle([STILL])).toBeNull();
    expect(countWords([PISO, { ...PISO, code: 'long_run' }])).toBe('2 warnings');
  });

  it('what a run started with: kept ones still count and say so', () => {
    expect(checkedAtStartLine([PISO, STILL])).toBe('Checked at start: 1 warning (Max Courant 100 with PISO)');
    expect(checkedAtStartLine([{ ...PISO, kept: true }])).toBe('Checked at start: 1 warning (Max Courant 100 with PISO, kept as set)');
    expect(checkedAtStartLine([STILL])).toBe('Checked at start: no warnings');
    expect(checkedAtStartLine(null)).toBeNull();
    expect(startedWithWords([PISO, STILL])).toBe('Started with 1 warning: Max Courant 100 with PISO.');
    expect(startedWithWords([STILL])).toBe('');
  });

  it('Apply all takes the problems and warnings shown, never the notes, and its title says what it changes', () => {
    const AVG: CheckRow = { code: 'average_startup', level: 'warn', text: 'Averages include the start-up.', fix: { label: 'Average from 0.6667 s', target: 'run', values: [{ key: 'transient.average_from', value: 0.6667 }] } };
    expect(applyAllFixes([PISO, AVG, STILL, MESH])).toEqual([PISO.fix, AVG.fix]);
    expect(applyAllTitle(applyAllFixes([PISO, AVG]))).toBe('Applies 3 outer correctors, Max Courant 5; Average from 0.6667 s');
  });

  it('a check of the settings only never says the mesh and physics were checked', () => {
    const partial = { complete: false, unchecked: 'its mesh and physics are checked once the mesh is generated' };
    expect(partialWords(partial)).toBe('Only its run settings were checked: its mesh and physics are checked once the mesh is generated.');
    expect(partialWords({ complete: true })).toBeNull();
    expect(partialWords(null)).toBeNull();
    expect(noneFoundWords(partial, false)).toBe('Nothing found in its run settings.');
    expect(noneFoundWords(partial, true)).toBe('Nothing else found in its run settings.');
    expect(noneFoundWords({ complete: true }, false)).toBe('Nothing found in its settings, mesh or physics.');
    expect(noneFoundWords(undefined, true)).toBe('Nothing else found.');
  });

  it("the Health block's fix takes the precheck's cost of the same values (spec 3.10)", () => {
    expect(precheckCost([PISO], [{ key: 'transient.max_co', value: 5 }, { key: 'transient.n_outer_correctors', value: 3 }])).toEqual({ steps: 180000, wall_s: 315000 });
    expect(precheckCost([PISO], [{ key: 'transient.max_co', value: 1 }])).toEqual({ steps: 900000, wall_s: 525000 });
    expect(precheckCost([PISO], [{ key: 'transient.max_co', value: 2 }])).toBeNull();
    const h = { findings: [{ fix: [{ label: 'New run', values: [{ key: 'transient.max_co', value: 1 }], cost: { steps: 1, wall_s: 1 } }] }] };
    expect(withPrecheckCosts(h, [PISO]).findings[0].fix[0].cost).toEqual({ steps: 900000, wall_s: 525000 });
    expect(withPrecheckCosts(h, null)).toBe(h);
  });
});
