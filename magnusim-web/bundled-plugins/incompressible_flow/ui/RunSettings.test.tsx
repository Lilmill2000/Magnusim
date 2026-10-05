import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../../src/panels/legacyBridge';
import { RunControl } from '../../../src/panels/run/RunControl';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { normalizeTransient } from './transient';

// Incompressible Flow's run settings in the core's run panel (H10).
const TRANSIENT_DEFAULTS = {
  end_time: 5,
  write_count: 50,
  time_step_mode: 'adjustable',
  max_co: 1,
  delta_t: null,
  max_delta_t: null,
  time_scheme: 'Euler',
  n_outer_correctors: 1,
  n_correctors: 2,
  n_non_orth_correctors: 0,
};
const UI = { study_settings: 'incompressible_flow.study', run_settings: 'incompressible_flow.run' };

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
    settings: { end_time: 200, write_interval: 50 },
    analysis_key: 'incompressible_steady',
    transient_settings: {},
    run_preview: null,
    progress: { show: false, title: 'Run', line: '', elapsed: '', eta: '', meta: '', residuals: [], end: 0 },
    copy: { available: false, picking: false, note: '', sources: [] },
    mesh_ready: true,
    has_material: true,
    has_flow_driver: true,
    ...overrides,
  };
}

beforeEach(() => {
  useProjectStore.setState({
    projectId: 'proj',
    registry: {
      analysis: [
        { key: 'incompressible_steady', label: 'Incompressible', time_dependency: 'steady', ui: UI, run_defaults: { end_time: 200, write_interval: 50 } },
        { key: 'incompressible_transient', label: 'Incompressible', time_dependency: 'transient', ui: UI, run_defaults: TRANSIENT_DEFAULTS },
      ],
    } as never,
  });
  window.__CFD_RUN_SAVE__ = vi.fn(async () => ({}));
  window.__CFD_RUN_TRANSIENT_SAVE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'incompressible_flow'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('incompressible_flow');
  delete window.__CFD_RUN_STATE__;
  delete window.__CFD_PLUGINS_READY__;
});

const renderPanel = () => render(<RunControl panelId="panel-sim-control" scope="p:proj/s:sim_1" />);

describe('run settings', () => {
  it('steady: iterations and write interval, saved as whole numbers', async () => {
    window.__CFD_RUN_STATE__ = runState();
    renderPanel();
    const it = screen.getByLabelText('Iterations');
    expect(it).toHaveValue('200');
    fireEvent.change(it, { target: { value: '12.4' } });
    fireEvent.blur(it);
    await waitFor(() => expect(window.__CFD_RUN_SAVE__).toHaveBeenCalledWith({ end_time: 12 }));
  });

  it('transient: the hint reads the preview the run model resolved', () => {
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
      run_preview: {
        ok: true,
        control: { adjust_time_step: true, delta_t: 1.2e-5, max_co: 1, source: { delta_t: 'auto' }, estimate: { steps: 4000 } },
      },
    });
    renderPanel();
    expect(screen.getByText(/A result frame every 0\.1 s \(50 frames\)/)).toHaveTextContent(
      'starting Δt ≈ 1.2e-5 s (auto), adjusted to keep Co ≤ 1 · roughly 4,000 time steps',
    );
    expect(screen.getByLabelText('Max Courant number')).toHaveValue('1');
  });

  it('transient: saves the whole block, clamped like the run model', async () => {
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS, max_delta_t: 0.05 },
    });
    renderPanel();
    const frames = screen.getByLabelText('Result frames');
    fireEvent.change(frames, { target: { value: '500' } });
    fireEvent.blur(frames);
    // 5 s / 500 frames = 0.01 s: Max Δt may not exceed one frame interval.
    await waitFor(() =>
      expect(window.__CFD_RUN_TRANSIENT_SAVE__).toHaveBeenCalledWith(
        expect.objectContaining({ write_count: 500, max_delta_t: 0.01, end_time: 5 }),
      ),
    );
    fireEvent.click(screen.getByText('Reset advanced to defaults'));
    await waitFor(() =>
      expect(window.__CFD_RUN_TRANSIENT_SAVE__).toHaveBeenLastCalledWith(
        expect.objectContaining({ end_time: 5, write_count: 50, max_delta_t: null, n_outer_correctors: 1 }),
      ),
    );
  });

  it('transient: Average from is saved in seconds, before the end time', async () => {
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
    });
    renderPanel();
    const from = screen.getByLabelText('Average from');
    expect(from).toHaveValue('0');
    fireEvent.change(from, { target: { value: '2.5' } });
    fireEvent.blur(from);
    await waitFor(() =>
      expect(window.__CFD_RUN_TRANSIENT_SAVE__).toHaveBeenLastCalledWith(expect.objectContaining({ average_from: 2.5, end_time: 5 })),
    );
    // Past the 5 s end: one frame interval (0.1 s) before it.
    fireEvent.change(from, { target: { value: '9' } });
    fireEvent.blur(from);
    await waitFor(() =>
      expect(window.__CFD_RUN_TRANSIENT_SAVE__).toHaveBeenLastCalledWith(expect.objectContaining({ average_from: 4.9 })),
    );
  });
});

describe('normalizeTransient', () => {
  it('keeps the limits the written case uses', () => {
    const out = normalizeTransient({ n_outer_correctors: 99, n_correctors: 0, write_count: 0, delta_t: -1 }, {}, TRANSIENT_DEFAULTS);
    expect(out).toMatchObject({ n_outer_correctors: 50, n_correctors: 1, write_count: 50, delta_t: null });
  });
});
