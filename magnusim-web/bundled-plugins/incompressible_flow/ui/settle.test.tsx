import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSettleMonitor, RunState } from '../../../src/panels/legacyBridge';
import { RunControl } from '../../../src/panels/run/RunControl';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { settleChoices, settleKind } from './settle';

// F5: "Stop when a monitor settles" in the run panel, and how a finished run ended.
const UI = { study_settings: 'incompressible_flow.study', run_settings: 'incompressible_flow.run' };
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

const MONITORS: RunSettleMonitor[] = [
  { id: 'rc-a', name: 'Area average 1', kind: 'area_average', source: 'monitor' },
  { id: 'rc-f', name: 'Forces 1', kind: 'forces', source: 'monitor' },
  { id: 'rc-p', name: 'Point probe 1', kind: 'probe', source: 'monitor' },
  { id: 'rc-old', name: 'Surface 1', kind: '', source: 'monitor', words: 'Surface data' },
  { id: 'rc-x', name: 'Something', kind: 'mystery', source: 'monitor' },
  { id: 'rc-empty', name: 'Forces 2', kind: 'forces', source: 'monitor', targets: 0 },
  { id: 'bc-in', name: 'Inlet', kind: 'boundary', source: 'boundary', bc_type: 'Velocity Inlet' },
  { id: 'bc-w', name: 'Wall', kind: 'boundary', source: 'boundary', bc_type: 'Wall' },
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
    settings: { end_time: 200, write_interval: 50 },
    analysis_key: 'incompressible_steady',
    transient_settings: {},
    run_preview: null,
    progress: { show: false, title: 'Run', line: '', elapsed: '', eta: '', meta: '', residuals: [], end: 0 },
    copy: { available: false, picking: false, note: '', sources: [] },
    mesh_ready: true,
    setup_ready: true,
    monitors: MONITORS,
    settle: null,
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
  window.__CFD_RUN_SETTLE_SAVE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'incompressible_flow'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('incompressible_flow');
  delete window.__CFD_RUN_STATE__;
  delete window.__CFD_PLUGINS_READY__;
  delete window.__CFD_RUN_SETTLE_SAVE__;
});

const renderPanel = () => render(<RunControl panelId="panel-sim-control" scope="p:proj/s:sim_1" />);
const options = () =>
  within(screen.getByLabelText('Stop when a monitor settles'))
    .getAllByRole('option')
    .map((o) => o.textContent);

describe('the quantities a run can stop on', () => {
  it('only those OpenFOAM can read while it solves, from openings and monitors it can watch', () => {
    expect(settleKind(MONITORS[3])).toBe('area_average');
    expect(settleKind(MONITORS[4])).toBe('');
    expect(settleKind(MONITORS[5])).toBe('');
    expect(settleKind(MONITORS[7])).toBe('');
    expect(settleChoices(MONITORS).map((c) => c.label)).toEqual([
      'Area average 1 · Pressure',
      'Area average 1 · Velocity',
      'Forces 1 · Cd',
      'Forces 1 · Cl',
      'Forces 1 · Cs',
      'Forces 1 · Cm',
      'Point probe 1 · Pressure (average of its points)',
      'Point probe 1 · Velocity (average of its points)',
      'Surface 1 · Pressure',
      'Surface 1 · Velocity',
      'Inlet · Pressure',
      'Inlet · Velocity',
      'Inlet · Flow rate',
    ]);
  });
});

describe('Stop when a monitor settles', () => {
  it('steady: Off by default; picking a quantity saves it with a starting amount and 100 iterations', async () => {
    window.__CFD_RUN_STATE__ = runState();
    renderPanel();
    const select = screen.getByLabelText('Stop when a monitor settles') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(options()[0]).toBe('Off');
    expect(options()).toContain('Forces 1 · Cd');
    expect(screen.queryByLabelText('Within')).toBeNull();
    fireEvent.change(select, { target: { value: String(options().indexOf('Forces 1 · Cd') - 1) } });
    await waitFor(() =>
      expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenCalledWith({
        source: 'monitor',
        id: 'rc-f',
        quantity: 'Cd',
        tolerance: 0.001,
        window: 100,
      }),
    );
  });

  it('steady: a saved stop shows its amount, window and sentence; edits and Off save', async () => {
    const settle = { source: 'boundary', id: 'bc-in', quantity: 'p', tolerance: 2, window: 150 };
    window.__CFD_RUN_STATE__ = runState({ settle });
    renderPanel();
    expect((screen.getByLabelText('Stop when a monitor settles') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'Inlet · Pressure',
    );
    expect(screen.getByLabelText('Within')).toHaveValue('2');
    expect(screen.getByLabelText('Over the last')).toHaveValue('150');
    expect(screen.getByText('Pa')).toBeTruthy();
    expect(screen.getByText('iterations')).toBeTruthy();
    expect(document.querySelector('[data-run-settle-hint]')).toHaveTextContent(
      'Ends the run once Inlet · Pressure stays within 2 Pa of its average over the last 150 iterations. The residual targets still end it too.',
    );
    const within_ = screen.getByLabelText('Within');
    fireEvent.change(within_, { target: { value: '0.5' } });
    fireEvent.blur(within_);
    await waitFor(() => expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenLastCalledWith({ ...settle, tolerance: 0.5 }));
    const span = screen.getByLabelText('Over the last');
    fireEvent.change(span, { target: { value: '80.6' } });
    fireEvent.blur(span);
    await waitFor(() => expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenLastCalledWith({ ...settle, window: 81 }));
    fireEvent.change(screen.getByLabelText('Stop when a monitor settles'), { target: { value: '' } });
    await waitFor(() => expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenLastCalledWith(null));
  });

  it('force coefficients say they need the reference area', () => {
    window.__CFD_RUN_STATE__ = runState({ settle: { source: 'monitor', id: 'rc-f', quantity: 'Cm', tolerance: 0.001, window: 100 } });
    renderPanel();
    expect(document.querySelector('[data-run-settle-hint]')).toHaveTextContent(
      "Force coefficients need the study's reference area and length (Reference values).",
    );
  });

  it('a removed monitor says it is not used, and the pick does not read Off', () => {
    window.__CFD_RUN_STATE__ = runState({ settle: { source: 'monitor', id: 'rc-gone', quantity: 'p', tolerance: 1, window: 10 } });
    renderPanel();
    expect(document.querySelector('[data-run-settle-hint]')).toHaveTextContent(
      'Not used as set: the monitor it watches was deleted. Pick another, or Off.',
    );
    expect((screen.getByLabelText('Stop when a monitor settles') as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      'Not available (not used)',
    );
  });

  it('a monitor placed on nothing says so', () => {
    window.__CFD_RUN_STATE__ = runState({ settle: { source: 'monitor', id: 'rc-empty', quantity: 'Cd', tolerance: 1, window: 10 } });
    renderPanel();
    expect(document.querySelector('[data-run-settle-hint]')).toHaveTextContent('Not used as set: Forces 2 is not placed on anything yet.');
  });

  it("a force coefficient checks the study's reference values before Start", () => {
    const cd = { source: 'monitor', id: 'rc-f', quantity: 'Cd', tolerance: 0.001, window: 100 };
    window.__CFD_RUN_STATE__ = runState({ settle: cd, study: { id: 'sim_1' } });
    const { unmount } = renderPanel();
    const hint = () => document.querySelector('[data-run-settle-hint]');
    expect(hint()).toHaveTextContent(
      "Not used as set: force coefficients need the study's reference area. Set it in the study's Reference values.",
    );
    expect(hint()).not.toHaveTextContent('Ends the run once');
    unmount();
    window.__CFD_RUN_STATE__ = runState({ settle: { ...cd, quantity: 'Cm' }, study: { id: 'sim_1', ref_area: 0.5 } });
    const second = renderPanel();
    expect(hint()).toHaveTextContent("Not used as set: the moment coefficient needs the study's reference length.");
    second.unmount();
    window.__CFD_RUN_STATE__ = runState({ settle: cd, study: { id: 'sim_1', ref_area: 0.5 } });
    renderPanel();
    expect(hint()).toHaveTextContent('Ends the run once Forces 1 · Cd stays within 0.001');
    expect(hint()).not.toHaveTextContent('Not used');
  });

  it('transient: the window is in seconds and starts at one result frame', async () => {
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText('Stop when a monitor settles'), {
      target: { value: String(options().indexOf('Area average 1 · Pressure') - 1) },
    });
    await waitFor(() =>
      expect(window.__CFD_RUN_SETTLE_SAVE__).toHaveBeenCalledWith({
        source: 'monitor',
        id: 'rc-a',
        quantity: 'p',
        tolerance: 1,
        window: 0.1,
      }),
    );
  });

  it('transient: a sampled monitor names the shortest window it gets', () => {
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
      settle: { source: 'monitor', id: 'rc-a', quantity: 'U', tolerance: 0.01, window: 0.5 },
    });
    renderPanel();
    expect(screen.getByLabelText('Over the last')).toHaveValue('0.5');
    // 5 s / 50 frames = 0.1 s a frame, 50 samples a frame: 10 samples = 0.02 s.
    expect(document.querySelector('[data-run-settle-hint]')).toHaveTextContent(
      'Ends the run once Area average 1 · Velocity stays within 0.01 m/s of its average over the last 0.5 s. A window shorter than 0.02 s (10 monitor samples) is made that long.',
    );
  });

  it('a started run shows its stop read-only, and nothing when it has none', () => {
    window.__CFD_RUN_STATE__ = runState({
      locked: true,
      status: 'done',
      settle: { source: 'monitor', id: 'rc-f', quantity: 'Cd', tolerance: 0.001, window: 100 },
    });
    const { unmount } = renderPanel();
    expect(screen.queryByLabelText('Stop when a monitor settles')).toBeNull();
    expect(document.querySelector('[data-run-settle]')).toHaveTextContent(
      'Stop when settledForces 1 · Cd stays within 0.001 of its average over the last 100 iterations',
    );
    unmount();
    window.__CFD_RUN_STATE__ = runState({ locked: true, status: 'done', settle: null });
    renderPanel();
    expect(document.querySelector('[data-run-settle]')).toBeNull();
  });

  it('a started run says when its plan did not use the stop, and shows what it wrote when it did', () => {
    const cd = { source: 'monitor', id: 'rc-f', quantity: 'Cd', tolerance: 0.001, window: 100 };
    window.__CFD_RUN_STATE__ = runState({
      locked: true,
      status: 'running',
      settle: cd,
      // The study has its area now: the plan's verdict at Start still stands.
      study: { id: 'sim_1', ref_area: 0.5 },
      stop_when: { label: 'Forces 1 · Cd', error: "force coefficients need the study's reference area" },
    });
    const { unmount } = renderPanel();
    expect(document.querySelector('[data-run-settle-unused]')).toHaveTextContent(
      "Stop when settled was not used: force coefficients need the study's reference area.",
    );
    unmount();
    window.__CFD_RUN_STATE__ = runState({
      locked: true,
      status: 'running',
      settle: { ...cd, quantity: 'U', id: 'rc-a', window: 0.005 },
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
      stop_when: { label: 'Area average 1 · Velocity', text: 'Area average 1 · Velocity stayed within 0.01 m/s of its average over 0.02 s' },
    });
    renderPanel();
    expect(document.querySelector('[data-run-settle-unused]')).toBeNull();
    expect(document.querySelector('[data-run-settle]')).toHaveTextContent(
      'Area average 1 · Velocity stays within 0.01 m/s of its average over 0.02 s',
    );
  });

  it('a part continued past its convergence says its stop is off', () => {
    window.__CFD_RUN_STATE__ = runState({
      locked: true,
      status: 'running',
      settle: { source: 'monitor', id: 'rc-f', quantity: 'Cd', tolerance: 0.001, window: 100 },
      stops_off: true,
    });
    renderPanel();
    expect(document.querySelector('[data-run-settle-off]')).toHaveTextContent(
      'Off for this part: the run continued past its convergence.',
    );
    expect(document.querySelector('[data-run-settle]')).not.toHaveTextContent('stays within');
  });
});

describe('how a finished run ended', () => {
  const done = (converged: RunState['progress']['converged'], title = 'Converged', line = 'Converged after 215 iterations') =>
    runState({
      status: 'done',
      locked: true,
      done: true,
      progress: { show: true, title, line, elapsed: '', eta: '', meta: '', residuals: [], end: 200, converged },
    });

  it('converged: the title, the line and the banner say so', () => {
    window.__CFD_RUN_STATE__ = done({ kind: 'residuals', text: 'Every residual met its target, so the solver stopped early.' });
    renderPanel();
    expect(screen.getByText('Converged')).toBeTruthy();
    expect(document.querySelector('[data-run-line]')).toHaveTextContent('Converged after 215 iterations');
    expect(document.querySelector('[data-run-converged="residuals"]')).toHaveTextContent(
      'Every residual met its target, so the solver stopped early.',
    );
  });

  it('a settled monitor: its sentence', () => {
    window.__CFD_RUN_STATE__ = done({ kind: 'monitor', text: 'Forces 1 · Cd stayed within 0.001 of its average over 100 iterations.' });
    renderPanel();
    expect(document.querySelector('[data-run-converged="monitor"]')).toHaveTextContent('Forces 1 · Cd stayed within 0.001');
  });

  it('not converged: the v0.2.0 title and line, and a marked note', () => {
    window.__CFD_RUN_STATE__ = done(
      { kind: 'no', text: 'Reached the iteration limit before the residuals met their targets.' },
      'Run finished',
      '200 iterations',
    );
    renderPanel();
    expect(screen.getByText('Run finished')).toBeTruthy();
    expect(document.querySelector('[data-run-line]')).toHaveTextContent('200 iterations');
    expect(document.querySelector('[data-run-converged="no"]')).toHaveClass('is-not');
  });

  it('a run from before: nothing more', () => {
    window.__CFD_RUN_STATE__ = done(null, 'Run finished', '200 iterations');
    renderPanel();
    expect(document.querySelector('[data-run-converged]')).toBeNull();
  });
});
