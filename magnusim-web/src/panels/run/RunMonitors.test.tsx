import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async () => {
  const { LEGACY_MONITOR_QUANTITIES } = await import('../../monitors');
  const base = LEGACY_MONITOR_QUANTITIES[0];
  const drag = { ...base, key: 'Fd', label: 'Drag force', sample: 'Fd_N', unit_quantity: 'force', unit: 'N', headline: true };
  const cd = { ...base, key: 'Cd', label: 'Drag coefficient', sample: 'Cd', unit_quantity: '', unit: '', headline: true };
  return {
    apiGet: vi.fn(async () => ({
      monitors: [{ name: 'Pressure 1', patch: 'pressure_1', final: { pressure_Pa: 0, volumetric_flow_m3s: 0.02 } }],
      custom: [
        { name: 'Area average 1', key: 'rc_area_average_1', final: { pressure_Pa: 135.7 } },
        {
          name: 'Forces 1',
          key: 'forces_forces_1',
          quantities: ['Fd', 'Cd'],
          final: { drag_N: 1.2 },
          series: [{ t: 8, Fd_N: 1.2, Cd: 0.31 }],
        },
        // A Forces monitor that has written nothing yet: no line.
        { name: 'Forces 2', key: 'forces:rc2', quantities: ['Fd'], series: [], note: 'No walls are picked.' },
      ],
      quantities: [...LEGACY_MONITOR_QUANTITIES, drag, cd],
    })),
  };
});

import { RunMonitors } from './RunMonitors';

afterEach(cleanup);

describe('RunMonitors', () => {
  it('lists custom monitors after the boundary monitors', async () => {
    render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} />);
    expect(await screen.findByText(/Area average 1 · 135\.7 Pa/)).toBeInTheDocument();
    expect(screen.getByText(/Pressure 1 · 0\.0 Pa/)).toBeInTheDocument();
  });

  it('lists a Forces monitor by its headline quantities', async () => {
    render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} />);
    expect(await screen.findByText('Forces 1 · Drag force 1.20 N · Drag coefficient 0.310')).toBeInTheDocument();
    expect(screen.queryByText(/Forces 2/)).toBeNull();
    expect(document.querySelectorAll('[data-run-monitors="1"] li')).toHaveLength(3);
  });
});
