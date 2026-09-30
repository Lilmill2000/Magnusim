import { describe, expect, it, vi } from 'vitest';

vi.mock('../wizard/controller', () => ({ initSetupWizard: () => {} }));

import { formatHomeSolveLine } from './controller';

// A project card's progress line reads the run on its analysis's x axis
// (contract x_axis): simulated seconds or iterations.
describe('home card progress', () => {
  const live = { simulating: true, sim_time: 1.5, sim_end: 5, iteration: 40, endTime: 200 };

  it('shows simulated time on a seconds axis', () => {
    expect(formatHomeSolveLine({ ...live, x_axis: 'seconds', time_dependency: 'Steady-state' })).toBe('1.5 s / 5 s');
  });

  it('shows iterations on an iterations axis', () => {
    expect(formatHomeSolveLine({ ...live, x_axis: 'iterations', time_dependency: 'Transient' })).toBe('40 / 200');
  });

  it('reads the time dependency when the server sends no axis', () => {
    expect(formatHomeSolveLine({ ...live, time_dependency: 'Transient' })).toBe('1.5 s / 5 s');
    expect(formatHomeSolveLine({ ...live, time_dependency: 'Steady-state' })).toBe('40 / 200');
  });

  it('adds the time left once the run has been solving a while', () => {
    const started = new Date(Date.now() - 60_000).toISOString();
    const line = formatHomeSolveLine({ ...live, x_axis: 'seconds', solve_started_at: started });
    expect(line).toMatch(/^1\.5 s \/ 5 s · ~\d+:\d\d left$/);
  });
});
