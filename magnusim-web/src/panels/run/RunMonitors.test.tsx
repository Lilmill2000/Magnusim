import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  apiGet: vi.fn(async () => ({
    monitors: [{ name: 'Pressure 1', patch: 'pressure_1', final: { pressure_Pa: 0, volumetric_flow_m3s: 0.02 } }],
    custom: [{ name: 'Area average 1', key: 'rc_area_average_1', final: { pressure_Pa: 135.7 } }],
  })),
}));

import { RunMonitors } from './RunMonitors';

afterEach(cleanup);

describe('RunMonitors', () => {
  it('lists custom monitors after the boundary monitors', async () => {
    render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} />);
    expect(await screen.findByText(/Area average 1 · 135\.7 Pa/)).toBeInTheDocument();
    expect(screen.getByText(/Pressure 1 · 0\.0 Pa/)).toBeInTheDocument();
  });
});
