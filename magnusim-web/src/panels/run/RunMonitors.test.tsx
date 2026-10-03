import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorQuantity } from '../../api/registry.gen';

const answer = vi.hoisted(() => ({ body: {} as Record<string, unknown> }));
vi.mock('../../api/client', () => ({ apiGet: vi.fn(async () => answer.body) }));

import { LEGACY_MONITOR_QUANTITIES } from '../../monitors';
import { RunMonitors } from './RunMonitors';

const outlet = {
  key: 'mon_pressure_1',
  name: 'Pressure 1',
  patch: 'pressure_1',
  last: { t: 4, U: [2, 0, 0], Umag: 2, p_Pa: 0, Q_m3s: 0.004, Un_m_s: 0.4, mdot_kgs: 0.0048 },
};
const custom = {
  key: 'rc_area_average_1',
  name: 'Area average 1',
  last: { t: 4, U: [1, 2, 2], Umag: 3, p_Pa: 135.7, Q_m3s: null, Un_m_s: null, mdot_kgs: null },
};

afterEach(cleanup);
beforeEach(() => {
  answer.body = {};
});

describe('RunMonitors', () => {
  it("lists each monitor's headline values, custom monitors after the boundaries", async () => {
    // A server that passes no quantities: the API 1.1 table.
    answer.body = { monitors: [outlet], custom: [custom] };
    render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} />);
    expect(await screen.findByText('Pressure 1 · 0 Pa · 2.00 m/s · 4.00 L/s out')).toBeInTheDocument();
    expect(screen.getByText('Area average 1 · 136 Pa · 3.00 m/s')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toMatch(/^Pressure 1/);
  });

  it('shows the quantities the answer or the analysis names', async () => {
    const temperature: MonitorQuantity = {
      ...LEGACY_MONITOR_QUANTITIES[0],
      key: 'T',
      label: 'Temperature',
      sample: 'T_K',
      unit_quantity: 'temperature',
      unit: 'K',
    };
    answer.body = { monitors: [{ key: 'mon_wall', name: 'Wall', last: { t: 1, T_K: 300.25, p_Pa: 5 } }] };
    render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} quantities={[temperature]} />);
    expect(await screen.findByText('Wall · 300 K')).toBeInTheDocument();
  });

  it('shows nothing before a monitor has values', async () => {
    answer.body = { monitors: [{ key: 'mon_inlet', name: 'Inlet', series: [] }], custom: [] };
    const { container } = render(<RunMonitors projectId="p" simulationId="s" runId="r" live={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-run-monitors]')).toBeNull();
  });
});
