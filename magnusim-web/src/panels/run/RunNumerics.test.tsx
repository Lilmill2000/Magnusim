import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunState } from '../legacyBridge';
import { RunNumerics, groupRows } from './RunNumerics';

// RH3 (spec 5.5): "Numerics as written", the rows the run's analysis gives (RunModel.check
// `numerics`), by group, each with where it comes from; nothing when there are none.
const ROWS = [
  { group: 'Schemes', label: 'Gradient limiter', value: 'cellLimited Gauss linear 1', source: 'preset' },
  { group: 'Schemes', label: 'Momentum convection', value: 'Gauss upwind', source: 'study' },
  { group: 'PIMPLE', label: 'Outer relaxation', value: 'p 0.4, equations 0.7; the final outer loop 1', source: 'run' },
  { group: 'Limiters', label: 'Velocity limit', value: '226 m/s = 10 × 22.6 m/s (inlet velocity_inlet_1_1)', source: 'default' },
  { group: 'Stays fixed', label: 'nCellsInCoarsestLevel', value: '20', source: 'fixed' },
];

describe('Numerics as written', () => {
  afterEach(() => cleanup());

  it('shows the rows by group with where each comes from', () => {
    const state = { numerics: ROWS, study: { numerics_preset: 'robust' } } as unknown as RunState;
    const { container } = render(<RunNumerics state={state} />);
    const box = container.querySelector('[data-run-numerics="1"]')!;
    expect(box.querySelector('summary')?.textContent).toBe('Numerics as written');
    expect([...box.querySelectorAll('.run-numerics-group')].map((g) => g.textContent)).toEqual(['Schemes', 'PIMPLE', 'Limiters', 'Stays fixed']);
    const row = (label: string) => box.querySelector(`[data-run-numerics-row="${label}"] .mat-v`)?.textContent;
    expect(row('Gradient limiter')).toBe('cellLimited Gauss linear 1 (Robust preset)');
    expect(row('Momentum convection')).toBe('Gauss upwind (set in the study)');
    expect(row('Outer relaxation')).toBe('p 0.4, equations 0.7; the final outer loop 1 (set on the run)');
    expect(row('Velocity limit')).toBe('226 m/s = 10 × 22.6 m/s (inlet velocity_inlet_1_1) (default)');
    expect(row('nCellsInCoarsestLevel')).toBe('20');
  });

  it('shows nothing without rows (a run started before its numerics were recorded)', () => {
    const { container } = render(<RunNumerics state={{ numerics: null } as unknown as RunState} />);
    expect(container.innerHTML).toBe('');
    expect(groupRows([])).toEqual([]);
  });
});
