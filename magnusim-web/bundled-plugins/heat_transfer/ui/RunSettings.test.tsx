import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../../src/panels/legacyBridge';
import { RunControl } from '../../../src/panels/run/RunControl';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { monitorProblem, readSettle, settleChoices, settleSentence, shownTolerance } from './RunSettings';

// Heat Transfer's run settings in the core's run panel: the control schema's rows and
// "Stop when a monitor settles" on the run's Heat Transfer monitors.

const UI = { study_settings: 'heat_transfer.study', run_settings: 'heat_transfer.run' };
const STEADY_CONTROL = {
  type: 'object',
  properties: {
    end_time: { type: 'integer', title: 'Number of iterations', default: 1000 },
    write_interval: { type: 'integer', title: 'Write interval', default: 100 },
  },
};
const MONITORS = [
  { id: 'mon-q', name: 'Heater flux', kind: 'ht_wall_heat_flux', source: 'monitor' as const, targets: 1 },
  { id: 'mon-t', name: 'Plates', kind: 'ht_surface_temperature', source: 'monitor' as const, targets: 2 },
  { id: 'mon-tc', name: 'Thermocouple 1', kind: 'ht_thermocouple', source: 'monitor' as const, targets: 1 },
  { id: 'bc-in', name: 'inlet', kind: 'boundary', source: 'boundary' as const, bc_type: 'Velocity inlet' },
];

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    has_run: true,
    run_id: 'r1',
    name: 'Run 1',
    status: 'draft',
    transient: false,
    locked: false,
    running: false,
    done: false,
    can_start: true,
    queued: false,
    start: { visible: true, enabled: true, label: 'Start', title: '' },
    stop: { visible: false, label: 'Stop', title: '' },
    can_delete: true,
    reason: null,
    settings: { end_time: 1000, write_interval: 100 },
    analysis_key: 'heat_transfer_steady',
    transient_settings: {},
    run_preview: null,
    progress: { show: false, title: 'Run', line: '', elapsed: '', eta: '', meta: '', residuals: [], end: 0 },
    copy: { available: false, picking: false, note: '', sources: [] },
    mesh_ready: true,
    has_material: true,
    has_flow_driver: true,
    monitors: MONITORS,
    ...overrides,
  } as RunState;
}

beforeEach(() => {
  useProjectStore.setState({
    projectId: 'proj',
    registry: {
      analysis: [
        {
          key: 'heat_transfer_steady',
          label: 'Heat Transfer',
          time_dependency: 'steady',
          ui: UI,
          control_schema: STEADY_CONTROL,
          run_defaults: { end_time: 1000, write_interval: 100 },
        },
      ],
    },
  });
  window.__CFD_RUN_STATE__ = runState();
  window.__CFD_RUN_SAVE__ = vi.fn(async () => ({}));
  window.__CFD_RUN_SETTLE_SAVE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'heat_transfer'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('heat_transfer');
  delete window.__CFD_RUN_STATE__;
  delete window.__CFD_PLUGINS_READY__;
});

describe('settle choices', () => {
  it('offers the quantities of the run’s Heat Transfer monitors only', () => {
    const choices = settleChoices(MONITORS);
    expect(choices.map((c) => c.label)).toEqual([
      'Heater flux · Heat flow',
      'Plates · Average temperature',
      'Plates · Highest temperature',
      'Thermocouple 1 · Temperature (average of its points)',
    ]);
    expect(choices[1].problem).toBe('Plates is on 2 boundaries; the stop watches a monitor on one');
    expect(monitorProblem({ id: 'x', name: 'Empty', kind: 'ht_thermocouple', source: 'monitor', targets: 0 })).toBe('Empty is placed on nothing');
    const s = readSettle({ id: 'mon-q', quantity: 'Q', tolerance: 0.01, window: 50 })!;
    expect(settleSentence(choices[0], s, false)).toBe('Heater flux · Heat flow stays within 0.01 W of its average over 50 iterations');
    expect(readSettle({ id: 'x', quantity: 'Q', tolerance: 0, window: 5 })).toBeNull();
  });

  it('a temperature tolerance shows as a difference in °C or °F, never K', () => {
    const tc = settleChoices(MONITORS)[3];
    const s = readSettle({ id: 'mon-tc', quantity: 'T_pt', tolerance: 0.05, window: 20 })!;
    expect(settleSentence(tc, s, false)).toBe(
      'Thermocouple 1 · Temperature (average of its points) stays within 0.05 °C of its average over 20 iterations',
    );
    expect(settleSentence(tc, s, false, true)).toBe(
      'Thermocouple 1 · Temperature (average of its points) stays within 0.09 °F of its average over 20 iterations',
    );
    expect(shownTolerance(tc.quantity, true)).toEqual({ unit: '°F', factor: 1.8 });
    expect(shownTolerance(settleChoices(MONITORS)[0].quantity, true)).toEqual({ unit: 'W', factor: 1 });
  });
});

describe('Heat Transfer run settings in the run panel', () => {
  it('shows the control rows and turns the settle stop on', async () => {
    render(<RunControl panelId="panel-run" scope="p:proj/s:sim_1/r:r1" />);
    expect(await screen.findByText('Number of iterations')).toBeInTheDocument();
    const stop = screen.getByLabelText('Stop when a monitor settles') as HTMLSelectElement;
    expect([...stop.options].map((o) => o.text)).toContain('Heater flux · Heat flow');
    const heat = [...stop.options].find((o) => o.text === 'Heater flux · Heat flow')!;
    fireEvent.change(stop, { target: { value: heat.value } });
    await waitFor(() =>
      expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenCalledWith({ source: 'monitor', id: 'mon-q', quantity: 'Q', tolerance: 0.01, window: 50 }),
    );
  });

  // A2: a stopped run's Max Courant, correctors and Max Δt may wait for its Continue.
  it('a stopped transient run: each setting that waits for Continue says so under its row', async () => {
    useProjectStore.setState({
      registry: {
        analysis: [
          {
            key: 'heat_transfer_transient',
            label: 'Heat Transfer',
            time_dependency: 'transient',
            ui: UI,
            control_schema: {
              type: 'object',
              properties: {
                end_time: { type: 'number', title: 'Simulation time', default: 10 },
                max_co: { type: 'number', title: 'Max Courant number', default: 0.8 },
                n_outer_correctors: { type: 'integer', title: 'Outer correctors', default: 1 },
              },
            },
            run_defaults: { end_time: 10, max_co: 0.8, n_outer_correctors: 1 },
          },
        ],
      },
    } as never);
    window.__CFD_RUN_STATE__ = runState({
      status: 'stopped',
      edit: 'continues',
      transient: true,
      analysis_key: 'heat_transfer_transient',
      transient_settings: { end_time: 10, max_co: 2, n_outer_correctors: 1 },
      continue_pending: ['transient.max_co'],
    } as Partial<RunState>);
    const { container } = render(<RunControl panelId="panel-run" scope="p:proj/s:sim_1/r:r1" />);
    expect(await screen.findByText('Max Courant number')).toBeInTheDocument();
    const marks = [...container.querySelectorAll('[data-run-takes-effect]')];
    expect(marks.map((m) => [m.getAttribute('data-run-takes-effect'), m.textContent])).toEqual([['max_co', 'Takes effect when you Continue']]);
    // Under its own row.
    const note = container.querySelector('[data-schema-note="max_co"]');
    expect(note?.previousElementSibling?.getAttribute('data-schema-key')).toBe('max_co');
  });

  it('an imperial project types the thermocouple tolerance in °F and saves it in K', async () => {
    window.__CFD_PROJECT_UNITS__ = () => 'Imperial';
    window.__CFD_RUN_STATE__ = runState({ settle: { id: 'mon-tc', quantity: 'T_pt', tolerance: 0.05, window: 20 } } as Partial<RunState>);
    render(<RunControl panelId="panel-run" scope="p:proj/s:sim_1/r:r1" />);
    const within = (await screen.findByLabelText('Within')) as HTMLInputElement;
    expect(within.value).toBe('0.09');
    expect(within.parentElement?.textContent).toContain('°F');
    fireEvent.change(within, { target: { value: '0.18' } });
    fireEvent.blur(within);
    await waitFor(() =>
      expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenCalledWith({ source: 'monitor', id: 'mon-tc', quantity: 'T_pt', tolerance: 0.1, window: 20 }),
    );
    delete window.__CFD_PROJECT_UNITS__;
  });

  it('a started run shows its stop as planned', () => {
    window.__CFD_RUN_STATE__ = runState({
      locked: true,
      status: 'running',
      settle: { id: 'mon-q', quantity: 'Q', tolerance: 0.01, window: 50 },
      stop_when: { label: 'Heater flux · Heat flow', text: 'Heater flux · Heat flow stayed within 0.01 W of its average over 50 iterations' },
    } as Partial<RunState>);
    render(<RunControl panelId="panel-run" scope="p:proj/s:sim_1/r:r1" />);
    expect(screen.getByText('Heater flux · Heat flow stays within 0.01 W of its average over 50 iterations')).toBeInTheDocument();
    expect(screen.getByText('1000')).toBeInTheDocument();
  });
});
