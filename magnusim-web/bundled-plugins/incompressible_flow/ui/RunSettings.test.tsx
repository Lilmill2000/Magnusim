import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../../../src/panels/legacyBridge';
import { RunControl } from '../../../src/panels/run/RunControl';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { normalizeTransient } from './transient';
import { OWN_ROWS } from './RunSettings';
import committed from '../../../scripts/generated/registry.json';

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
  // A run that ended (runReopen.ts): the core asks before a change, so the fields stay usable.
  it("a finished run (edit new_run): its solve fields stay usable and save through the core; a running run's are off", async () => {
    window.__CFD_RUN_STATE__ = runState({ status: 'done', done: true, locked: true, edit: 'new_run' });
    renderPanel();
    const it = screen.getByLabelText('Iterations');
    expect(it).toBeEnabled();
    expect(screen.getByLabelText('Write interval')).toBeEnabled();
    fireEvent.change(it, { target: { value: '300' } });
    fireEvent.blur(it);
    await waitFor(() => expect(window.__CFD_RUN_SAVE__).toHaveBeenCalledWith({ end_time: 300 }));
    cleanup();
    window.__CFD_RUN_STATE__ = runState({ status: 'running', running: true, locked: true, edit: 'locked' });
    renderPanel();
    expect(screen.getByLabelText('Iterations')).toBeDisabled();
    cleanup();
    // A state from before `edit`: locked is locked.
    window.__CFD_RUN_STATE__ = runState({ status: 'done', done: true, locked: true });
    renderPanel();
    expect(screen.getByLabelText('Iterations')).toBeDisabled();
  });

  // A2: a stopped run's Max Courant, correctors and Max Δt may wait for its Continue.
  it('a stopped transient run (edit continues): its fields stay usable, and each setting that waits for Continue says so', () => {
    const stopped = {
      status: 'stopped',
      edit: 'continues' as const,
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS, max_co: 5, n_outer_correctors: 3, max_delta_t: 0.01 },
      cont: {
        visible: true,
        enabled: true,
        transient: true,
        from: 0.05,
        value: 0.1,
        write_interval: null,
        reason: '',
        applies: 'Continue applies: Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.05 s).',
      },
    };
    window.__CFD_RUN_STATE__ = runState({ ...stopped, continue_pending: ['transient.max_co', 'transient.n_outer_correctors'] });
    const { container } = renderPanel();
    expect(screen.getByLabelText('Max Courant number')).toBeEnabled();
    expect(screen.getByLabelText('Max Courant number')).toHaveValue('5');
    const marks = [...container.querySelectorAll('[data-run-takes-effect]')];
    expect(marks.map((m) => [m.getAttribute('data-run-takes-effect'), m.textContent])).toEqual([
      ['max_co', 'Takes effect when you Continue'],
      ['n_outer_correctors', 'Takes effect when you Continue'],
    ]);
    // Each under its own row.
    expect(container.querySelector('[data-run-takes-effect="max_co"]')?.previousElementSibling?.textContent).toContain('Max Courant number');
    expect(container.querySelector('[data-run-continue-changes]')?.textContent).toBe('Continue applies: Max Courant 100 → 5, outer correctors 1 → 3 (from t = 0.05 s).');
    cleanup();
    // Max Δt waits too; nothing waiting: no mark and no line.
    window.__CFD_RUN_STATE__ = runState({ ...stopped, continue_pending: ['transient.max_delta_t'] });
    renderPanel();
    expect(document.querySelectorAll('[data-run-takes-effect]').length).toBe(1);
    expect(document.querySelector('[data-run-takes-effect="max_delta_t"]')).not.toBeNull();
    cleanup();
    window.__CFD_RUN_STATE__ = runState({ ...stopped, cont: { ...stopped.cont, applies: '' } });
    renderPanel();
    expect(document.querySelectorAll('[data-run-takes-effect]').length).toBe(0);
    expect(document.querySelector('[data-run-continue-changes]')).toBeNull();
  });

  it('a finished transient run (edit new_run): its transient fields stay usable', () => {
    window.__CFD_RUN_STATE__ = runState({
      status: 'done',
      done: true,
      locked: true,
      edit: 'new_run',
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...TRANSIENT_DEFAULTS },
    });
    renderPanel();
    expect(screen.getByLabelText('Simulation time')).toBeEnabled();
    expect(screen.getByLabelText('Result frames')).toBeEnabled();
  });

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

// RH3 (spec 5.5, 5.9): every field of the registry's transient control schema is on the panel: its
// own rows (OWN_ROWS), the rest in a schema form (the outer loops' relaxation and tolerance), with
// their tooltips the schema's descriptions; an edit of one is saved, one out of its range is not.
describe('RH3: the control schema on the Run panel', () => {
  const control = (committed as unknown as { analysis: Array<{ key: string; control_schema: { properties: Record<string, { title: string; description?: string }> }; run_defaults: Record<string, unknown> }> }).analysis.find(
    (a) => a.key === 'incompressible_transient',
  )!;
  // The panel's own rows by the label (or aria-label) the person reads.
  const OWN_LABEL: Record<string, string> = {
    end_time: 'Simulation time',
    write_count: 'Result frames',
    average_from: 'Average from',
    time_step_mode: 'Time step mode',
    max_co: 'Max Courant number',
    delta_t: 'Time step in seconds',
    max_delta_t: 'Maximum time step in seconds',
    time_scheme: 'Time scheme',
    n_outer_correctors: 'Outer correctors',
    n_correctors: 'Pressure correctors',
    n_non_orth_correctors: 'Non-orthogonal correctors',
  };

  function renderTransient(settings: Record<string, unknown> = {}) {
    useProjectStore.setState({
      registry: {
        analysis: [{ key: 'incompressible_transient', label: 'Incompressible', time_dependency: 'transient', ui: UI, run_defaults: control.run_defaults, control_schema: control.control_schema }],
      } as never,
    });
    window.__CFD_RUN_STATE__ = runState({
      transient: true,
      analysis_key: 'incompressible_transient',
      transient_settings: { ...control.run_defaults, ...settings },
    });
    return renderPanel();
  }

  it('renders every control_schema field: its own rows and a schema form for the others', () => {
    const { container } = renderTransient();
    const keys = Object.keys(control.control_schema.properties);
    expect(keys).toEqual(expect.arrayContaining(['outer_relax_p', 'outer_relax_eq', 'outer_tolerance']));
    expect([...OWN_ROWS].sort()).toEqual(Object.keys(OWN_LABEL).sort());
    for (const key of keys) {
      if (OWN_ROWS.includes(key)) expect(screen.getAllByLabelText(OWN_LABEL[key]).length, key).toBeGreaterThan(0);
      else expect(container.querySelector(`[data-run-numerics-fields] [data-schema-key="${key}"]`), key).not.toBeNull();
    }
    // Their tooltips are the schema's descriptions (one advice source).
    const tip = container.querySelector('[data-schema-key="outer_tolerance"] [role="tooltip"]');
    expect(tip?.textContent).toBe(control.control_schema.properties.outer_tolerance.description);
  });

  it('an outer relaxation edit is saved; one outside its range is not, and says why; a saved one outside it is kept', async () => {
    renderTransient({ n_outer_correctors: 3, outer_tolerance: 0.5 });
    // Saved outside its range: shown as saved, used as saved.
    expect(screen.getByText('Saved as 5e-1, outside 1e-6 to 1e-1. It is used as saved.')).toBeInTheDocument();
    const relax = screen.getByLabelText('Outer relaxation p');
    fireEvent.change(relax, { target: { value: '0.4' } });
    fireEvent.blur(relax);
    await waitFor(() =>
      expect(window.__CFD_RUN_TRANSIENT_SAVE__).toHaveBeenLastCalledWith(expect.objectContaining({ outer_relax_p: 0.4, outer_tolerance: 0.5, n_outer_correctors: 3 })),
    );
    const eq = screen.getByLabelText('Outer relaxation equations');
    fireEvent.change(eq, { target: { value: '1.5' } });
    fireEvent.blur(eq);
    expect(await screen.findByText('Not saved: 1.5 is outside 0 to 1.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    // No save carries it (this test's run state stays as it was, so the earlier edit may go again).
    const saves = (window.__CFD_RUN_TRANSIENT_SAVE__ as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(saves.every((s) => s.outer_relax_eq == null)).toBe(true);
  });
});
