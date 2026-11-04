import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../../../src/panels/legacyBridge';
import { SimulationDefaults } from '../../../src/panels/simulation/SimulationPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { numericsData, shownValues, turbulenceKey } from './StudySettings';

// Incompressible Flow's study settings in the core's study panel (H10: the
// component is the plugin's, the chrome around it the core's).

const settingsSchema = {
  type: 'object',
  properties: {
    turbulence_model: {
      type: 'string',
      title: 'Turbulence model',
      enum: ['laminar', 'SpalartAllmaras', 'kEpsilon', 'realizableKE', 'kOmegaSST', 'LRR', 'SSG'],
      default: 'kOmegaSST',
      description: 'Which turbulence closure the solver uses.',
      'x-cfddesk': {
        enum_labels: [
          'Laminar',
          'Spalart-Allmaras (one equation)',
          'k-epsilon',
          'Realizable k-epsilon',
          'k-omega SST',
          'LRR (Reynolds stress)',
          'SSG (Reynolds stress)',
        ],
      },
    },
  },
};
const numericsSchema = {
  type: 'object',
  properties: {
    residual_u: { type: 'number', title: 'Residual U', default: 1e-4, description: 'Convergence target for velocity.' },
    relax_p: { type: 'number', title: 'Relaxation p', default: 0.3, description: 'Under-relaxation for pressure.' },
  },
};

function study(overrides: Partial<StudyState> = {}, record: Record<string, unknown> = {}): StudyState {
  return {
    has_study: true,
    id: 'sim_1',
    name: 'Incompressible Steady-state 2',
    analysis: 'Incompressible',
    analysis_type: 'incompressible_steady',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    record: { id: 'sim_1', turbulence_model: 'k-omega SST', turbulence_model_key: 'kOmegaSST', ...record },
    ...overrides,
  };
}

function publish(state: StudyState) {
  window.__CFD_STUDY_STATE__ = state;
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:study', { detail: state }));
  });
}

beforeEach(() => {
  useProjectStore.setState({
    projectId: 'proj',
    registry: {
      analysis: [
        {
          key: 'incompressible_steady',
          label: 'Incompressible Fluid Flow',
          schema: settingsSchema,
          numerics_schema: numericsSchema,
          ui: { study_settings: 'incompressible_flow.study', run_settings: 'incompressible_flow.run' },
        },
      ],
    },
  });
  window.__CFD_STUDY_STATE__ = study();
  window.__CFD_STUDY_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_TIME__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'incompressible_flow'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('incompressible_flow');
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_PLUGINS_READY__;
});

function renderPanel() {
  return render(<SimulationDefaults panelId="panel-study-settings" scope="p:proj/s:sim_1" />);
}

describe('turbulenceKey', () => {
  it('reads display text, keys and defaults', () => {
    expect(turbulenceKey({ turbulence_model: 'k-omega SST' })).toBe('kOmegaSST');
    expect(turbulenceKey({ turbulence_model: 'kEpsilon', turbulence_model_key: 'kOmegaSST' })).toBe('kEpsilon');
    expect(turbulenceKey({ defaults: { turbulence_model: 'Laminar' } })).toBe('laminar');
    expect(turbulenceKey({ turbulence_model: 'SpalartAllmaras' })).toBe('SpalartAllmaras');
    expect(turbulenceKey({ turbulence_model: 'Spalart-Allmaras' })).toBe('SpalartAllmaras');
    expect(turbulenceKey({ turbulence_model: 'realizableKE' })).toBe('realizableKE');
    expect(turbulenceKey({ turbulence_model: 'Realizable k-epsilon' })).toBe('realizableKE');
    expect(turbulenceKey({})).toBeUndefined();
  });
});

describe('numericsData', () => {
  const schema = { type: 'object' as const, properties: { relax_u: { type: 'number' as const }, relax_p: { type: 'number' as const } } };
  it('shows Relaxation U 0.5 for Reynolds-stress models the study has not set', () => {
    expect(numericsData({}, schema, 'LRR').relax_u).toBe(0.5);
    expect(numericsData({}, schema, 'SSG').relax_u).toBe(0.5);
    expect(numericsData({}, schema, 'kOmegaSST').relax_u).toBeUndefined();
    expect(numericsData({ relax_u: 0.8 }, schema, 'LRR').relax_u).toBe(0.8);
  });
});

describe('SimulationDefaults (study panel)', () => {
  it('shows the V0.1.0 rows and the SIMPLE numerics, with no dead controls', () => {
    renderPanel();
    expect(screen.getByText('Incompressible Steady-state 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename simulation' })).toBeInTheDocument();
    expect(screen.getByText('Analysis').nextSibling).toHaveTextContent('Incompressible');
    const turb = screen.getByLabelText('Turbulence model', { selector: 'select' }) as HTMLSelectElement;
    expect([...turb.options].map((o) => o.text)).toEqual([
      'Laminar',
      'Spalart-Allmaras (one equation)',
      'k-epsilon',
      'Realizable k-epsilon',
      'k-omega SST',
      'LRR (Reynolds stress)',
      'SSG (Reynolds stress)',
    ]);
    expect(turb.options[turb.selectedIndex].text).toBe('k-omega SST');
    expect((screen.getByLabelText('Time dependency') as HTMLSelectElement).value).toBe('Steady-state');
    expect(screen.getByText('SIMPLE')).toBeInTheDocument();
    expect(screen.getByText(/simpleFoam/)).toBeInTheDocument();
    expect(screen.getByText('Residual U')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Residual U' })).toBeInTheDocument();
    for (const gone of [/Energy/, /Passive species/, /Time scheme/]) expect(screen.queryByText(gone)).toBeNull();
  });

  it('saves a new turbulence model as both the model and its key', async () => {
    renderPanel();
    const turb = screen.getByLabelText('Turbulence model', { selector: 'select' }) as HTMLSelectElement;
    const kEps = [...turb.options].find((o) => o.text === 'k-epsilon')!;
    fireEvent.change(turb, { target: { value: kEps.value } });
    await waitFor(() =>
      expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ turbulence_model: 'kEpsilon', turbulence_model_key: 'kEpsilon' }),
    );
  });

  it.each([
    ['Spalart-Allmaras (one equation)', 'SpalartAllmaras'],
    ['Realizable k-epsilon', 'realizableKE'],
  ])('saves %s as its OpenFOAM model and shows it picked', async (label, key) => {
    renderPanel();
    const turb = screen.getByLabelText('Turbulence model', { selector: 'select' }) as HTMLSelectElement;
    const option = [...turb.options].find((o) => o.text === label)!;
    fireEvent.change(turb, { target: { value: option.value } });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ turbulence_model: key, turbulence_model_key: key }));
    cleanup();
    window.__CFD_STUDY_STATE__ = study({}, { turbulence_model: key, turbulence_model_key: key });
    renderPanel();
    const again = screen.getByLabelText('Turbulence model', { selector: 'select' }) as HTMLSelectElement;
    expect(again.options[again.selectedIndex].text).toBe(label);
  });

  it('switches time dependency through the runtime; a transient study shows its own numerics (RH3) and says where the time step lives', async () => {
    // The transient analysis's numerics: RH3's schemes (no SIMPLE ones).
    const state = useProjectStore.getState();
    const rows = ((state.registry as { analysis: Array<Record<string, unknown>> }).analysis || []).slice();
    rows.push({
      key: 'incompressible_transient',
      label: 'Incompressible Fluid Flow (Transient)',
      schema: settingsSchema,
      numerics_schema: {
        type: 'object',
        properties: {
          grad_limiter: { type: 'string', title: 'Gradient limiter', enum: ['strong', 'light', 'none'], default: null, 'x-cfddesk': { group: 'schemes', advanced: true, optional: true } },
        },
      },
      ui: { study_settings: 'incompressible_flow.study', run_settings: 'incompressible_flow.run' },
    });
    useProjectStore.setState({ registry: { ...(state.registry as object), analysis: rows } });
    renderPanel();
    fireEvent.change(screen.getByLabelText('Time dependency'), { target: { value: 'Transient' } });
    expect(window.__CFD_STUDY_TIME__).toHaveBeenCalledWith('Transient');
    publish(study({ time_dependency: 'Transient', algorithm: 'PIMPLE', analysis_type: 'incompressible_transient' }));
    expect(screen.getByText('PIMPLE')).toBeInTheDocument();
    expect(screen.queryByText('Residual U')).toBeNull();
    expect(screen.getByText('Gradient limiter')).toBeInTheDocument();
    expect(screen.getByText('Schemes')).toBeInTheDocument();
    expect(screen.getByText("The time step and PIMPLE correctors are on each run's panel.")).toBeInTheDocument();
  });

  it('renames and deletes through the runtime, and shows a failed save', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Rename simulation' }));
    const input = screen.getByLabelText('Simulation name');
    fireEvent.change(input, { target: { value: 'Swirl study' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ name: 'Swirl study' }));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(window.__CFD_STUDY_DELETE__).toHaveBeenCalled();

    window.__CFD_STUDY_TIME__ = vi.fn(async () => {
      throw new Error('Could not change time dependency');
    });
    fireEvent.change(screen.getByLabelText('Time dependency'), { target: { value: 'Transient' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change time dependency');
  });

  it('says SIMPLEC uses its own relaxation in place of the hidden relaxation rows', async () => {
    const withSimplec = {
      type: 'object',
      properties: {
        numerics_preset: {
          type: 'string',
          title: 'Numerics',
          enum: ['robust', 'accurate'],
          default: 'robust',
          'x-cfddesk': { enum_labels: ['Robust', 'Accurate'] },
        },
        simplec: { type: 'boolean', title: 'SIMPLEC (consistent)', default: false },
        relax_u: { type: 'number', title: 'Relaxation U', default: 0.7, 'x-cfddesk': { depends_on: { simplec: false } } },
        relax_p: { type: 'number', title: 'Relaxation p', default: 0.3, 'x-cfddesk': { depends_on: { simplec: false } } },
      },
    };
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: [{ ...reg.analysis[0], numerics_schema: withSimplec }] } });
    window.__CFD_STUDY_STATE__ = study({}, { simplec: false });
    const view = renderPanel();
    expect(screen.getByText('Relaxation U')).toBeInTheDocument();
    expect(view.container.querySelector('[data-study-simplec-note]')).toBeNull();
    const preset = screen.getByLabelText('Numerics', { selector: 'select' }) as HTMLSelectElement;
    expect([...preset.options].map((o) => o.text)).toEqual(['Robust', 'Accurate']);
    const accurate = [...preset.options].find((o) => o.text === 'Accurate')!;
    fireEvent.change(preset, { target: { value: accurate.value } });
    await waitFor(() =>
      expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith(expect.objectContaining({ numerics_preset: 'accurate' })),
    );

    publish(study({}, { simplec: true }));
    expect(screen.queryByText('Relaxation U')).toBeNull();
    expect(screen.queryByText('Relaxation p')).toBeNull();
    const note = view.container.querySelector('[data-study-simplec-note]') as HTMLElement;
    expect(note).toHaveTextContent('SIMPLEC relaxes velocity and turbulence by 0.9 and leaves pressure unrelaxed (1)');

    // A Reynolds-stress model keeps its own lower relaxation, and the note says so.
    publish(study({}, { simplec: true, turbulence_model: 'LRR' }));
    expect(view.container.querySelector('[data-study-simplec-note]')).toHaveTextContent(
      "SIMPLEC relaxes velocity and turbulence by 0.5 (the Reynolds-stress model's own, below SIMPLEC's 0.9) and leaves pressure unrelaxed (1), in place of the study's relaxation.",
    );
  });

  it('shows the starting flow and saves it with the other study settings', async () => {
    const component = (axis: string) => ({
      type: 'number',
      title: `Starting velocity ${axis}`,
      default: 0,
      'x-cfddesk': { unit: 'm/s', quantity: 'velocity', depends_on: { initial_flow: 'custom' } },
    });
    const withStart = {
      type: 'object',
      properties: {
        ...settingsSchema.properties,
        initial_flow: {
          type: 'string',
          title: 'Starting flow',
          enum: ['still', 'inlet', 'custom'],
          default: 'still',
          'x-cfddesk': { enum_labels: ['Still', 'From the inlet', 'Custom'] },
        },
        initial_ux: component('X'),
        initial_uy: component('Y'),
        initial_uz: component('Z'),
      },
    };
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: [{ ...reg.analysis[0], schema: withStart }] } });
    window.__CFD_STUDY_STATE__ = study({}, { initial_flow: 'still' });
    const view = renderPanel();
    const start = screen.getByLabelText('Starting flow', { selector: 'select' }) as HTMLSelectElement;
    expect([...start.options].map((o) => o.text)).toEqual(['Still', 'From the inlet', 'Custom']);
    expect(view.container.querySelector('[data-schema-key="initial_ux"]')).toBeNull();
    const custom = [...start.options].find((o) => o.text === 'Custom')!;
    fireEvent.change(start, { target: { value: custom.value } });
    await waitFor(() =>
      expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith(expect.objectContaining({ initial_flow: 'custom' })),
    );

    publish(study({}, { initial_flow: 'custom', initial_ux: 2.5 }));
    const row = view.container.querySelector('[data-schema-key="initial_ux"]') as HTMLElement;
    expect(within(row).getByRole('textbox')).toHaveValue('2.5');
    expect(row).toHaveTextContent('m/s');
  });

  it('keeps the saved numbers the solve will use', () => {
    window.__CFD_STUDY_STATE__ = study({}, { residual_u: 2e-5, relax_p: 0.2 });
    renderPanel();
    const row = screen.getByText('Residual U').closest('[data-schema-key]') as HTMLElement;
    expect(within(row).getByRole('textbox')).toHaveValue('2.0000e-5');
  });
});

describe('Reference values', () => {
  const ref = (extra: Record<string, unknown> = {}) => ({ type: 'number', 'x-cfddesk': { group: 'reference', optional: true, ...extra } });
  const vec = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, 'x-cfddesk': { group: 'reference' } };
  beforeEach(() => {
    const row = useProjectStore.getState().registry!.analysis![0] as Record<string, unknown>;
    row.schema = {
      type: 'object',
      properties: {
        ...settingsSchema.properties,
        ref_speed: ref({ quantity: 'velocity' }),
        ref_pressure: ref({ quantity: 'pressure' }),
        ref_area: ref({ quantity: 'area' }),
        ref_length: ref({ quantity: 'length' }),
        ref_cofr: vec,
        ref_drag_dir: vec,
        ref_lift_dir: vec,
      },
    };
  });
  afterEach(() => {
    delete window.__CFD_PROJECT_UNITS__;
  });

  const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
  const type = (name: string, value: string) => {
    fireEvent.focus(box(name));
    fireEvent.change(box(name), { target: { value } });
    fireEvent.blur(box(name));
  };

  it('is its own section, not rows of the turbulence form, with the blanks explained', () => {
    renderPanel();
    expect(screen.getByText('Reference values')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-schema-key^="ref_"]')).toHaveLength(0);
    expect(box('Reference speed')).toHaveAttribute('placeholder', 'Inlet speed');
    expect(box('Reference area')).toHaveAttribute('placeholder', 'Not set');
    expect(box('Drag direction X')).toHaveAttribute('placeholder', 'auto');
    expect(screen.getByText(/The density is the fluid/)).toBeInTheDocument();
  });

  it('saves typed values in SI and a cleared value as blank', async () => {
    renderPanel();
    type('Reference area', '0.5');
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ ref_area: 0.5 }));
    // Lengths show like the geometry: millimetres.
    type('Reference length', '250');
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ ref_length: 0.25 }));
    type('Drag direction Y', '1');
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ ref_drag_dir: [0, 1, 0] }));
    publish(study({}, { ref_speed: 12, ref_cofr: [0.1, 0, 0] }));
    expect(box('Reference speed')).toHaveValue('12');
    expect(box('Centre of rotation X')).toHaveValue('100');
    type('Reference speed', '');
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ ref_speed: null }));
    // A negative area is not a reference area: nothing is saved.
    (window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mockClear();
    type('Reference area', '-2');
    expect(window.__CFD_STUDY_UPDATE__).not.toHaveBeenCalled();
  });

  it('shows Imperial projects their units', async () => {
    window.__CFD_PROJECT_UNITS__ = () => 'Imperial';
    window.__CFD_STUDY_STATE__ = study({}, { ref_area: 0.09290304, ref_speed: 3.048 });
    renderPanel();
    expect(box('Reference area')).toHaveValue('1');
    expect(box('Reference speed')).toHaveValue('10');
    expect(screen.getByText('ft²')).toBeInTheDocument();
    type('Reference length', '10');
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ ref_length: 0.254 }));
  });

  // The study record changes only when a save answers. A component typed before that
  // was saved with the others' old values (X then Z typed quickly lost X), and a box
  // showed its old value until the answer.
  it('builds on and shows what was typed while its save is on its way', async () => {
    const answers: Array<() => void> = [];
    const update = vi.fn(() => new Promise<unknown>((resolve) => answers.push(() => resolve({}))));
    window.__CFD_STUDY_UPDATE__ = update;
    renderPanel();
    type('Centre of rotation X', '250');
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ref_cofr: [0.25, 0, 0] }));
    expect(box('Centre of rotation X')).toHaveValue('250');
    type('Centre of rotation Z', '-10');
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ ref_cofr: [0.25, 0, -0.01] }));
    expect(box('Centre of rotation X')).toHaveValue('250');
    expect(box('Centre of rotation Z')).toHaveValue('-10');
    type('Reference area', '0.5');
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ ref_area: 0.5 }));
    expect(box('Reference area')).toHaveValue('0.5');

    // Answered: the boxes show the saved study.
    publish(study({}, { ref_cofr: [0.25, 0, -0.01], ref_area: 0.5 }));
    await act(async () => answers.forEach((answer) => answer()));
    expect(box('Centre of rotation X')).toHaveValue('250');
    expect(box('Centre of rotation Z')).toHaveValue('-10');
    expect(box('Reference area')).toHaveValue('0.5');
  });
});

// RH3 (spec 5.5): the preset note, and a saved numerics value outside its range.
describe('RH3: the study numerics', () => {
  const withSchemes = {
    type: 'object',
    properties: {
      numerics_preset: { type: 'string', title: 'Numerics', enum: ['robust', 'accurate'], default: 'robust', 'x-cfddesk': { enum_labels: ['Robust', 'Accurate'] } },
      grad_limiter: { type: 'string', title: 'Gradient limiter', enum: ['strong', 'light', 'none'], default: null, 'x-cfddesk': { group: 'schemes', advanced: true, optional: true } },
      momentum_convection: { type: 'string', title: 'Momentum convection', enum: ['first_order', 'second_order'], default: 'second_order', 'x-cfddesk': { group: 'schemes', advanced: true } },
      non_orth_correction: { type: 'string', title: 'Non-orthogonal correction', enum: ['full', 'none'], default: null, 'x-cfddesk': { group: 'schemes', advanced: true, optional: true } },
      p_tolerance: { type: 'number', title: 'p tolerance', default: 1e-7, minimum: 1e-12, maximum: 1e-3, 'x-cfddesk': { group: 'linear_solvers', advanced: true } },
    },
  };
  function withNumerics() {
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: [{ ...reg.analysis[0], numerics_schema: withSchemes }] } });
  }

  it('"Robust, 2 terms changed · Use the preset for all": the button clears them', async () => {
    withNumerics();
    window.__CFD_STUDY_STATE__ = study({}, { grad_limiter: 'light', non_orth_correction: 'full', momentum_convection: 'second_order' });
    const view = renderPanel();
    const note = view.container.querySelector('[data-study-preset-note="1"]')!;
    expect(note.textContent).toBe('Robust, 2 terms changed · Use the preset for all');
    fireEvent.click(screen.getByRole('button', { name: 'Use the preset for all' }));
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ grad_limiter: null, non_orth_correction: null }));
    publish(study({}, { momentum_convection: 'first_order' }));
    expect(view.container.querySelector('[data-study-preset-note="1"]')?.textContent).toBe('Robust, 1 term changed · Use the preset for all');
    publish(study({}, {}));
    expect(view.container.querySelector('[data-study-preset-note="1"]')).toBeNull();
  });

  it('an edit saves only what the person changed: a default the form showed stays blank (a run Continue names only the change)', async () => {
    withNumerics();
    window.__CFD_STUDY_STATE__ = study({}, {});
    renderPanel();
    fireEvent.change(screen.getByLabelText('Momentum convection', { selector: 'select' }), { target: { value: '0' } });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalled());
    expect((window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mock.calls.map(([patch]) => patch)).toEqual([{ momentum_convection: 'first_order' }]);
    // What the form shows: the saved value, else the default; a blank-able field stays blank.
    expect(shownValues({ p_tolerance: 0.01 }, withSchemes as never)).toEqual({ p_tolerance: 0.01, numerics_preset: 'robust', momentum_convection: 'second_order' });
  });

  it("a Reynolds-stress study's Relaxation U (shown 0.5) is not saved by an edit of another field", async () => {
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    const relax = { type: 'object', properties: { ...numericsSchema.properties, relax_u: { type: 'number', title: 'Relaxation U', default: 0.7 } } };
    useProjectStore.setState({ registry: { ...reg, analysis: [{ ...reg.analysis[0], numerics_schema: relax }] } });
    window.__CFD_STUDY_STATE__ = study({}, { turbulence_model: 'LRR', turbulence_model_key: 'LRR' });
    renderPanel();
    expect(screen.getByLabelText('Relaxation U')).toHaveValue('0.5');
    const p = screen.getByLabelText('Relaxation p');
    fireEvent.change(p, { target: { value: '0.2' } });
    fireEvent.keyDown(p, { key: 'Enter' });
    fireEvent.blur(p);
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalled());
    for (const [patch] of (window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mock.calls) expect(patch).toEqual({ relax_p: 0.2 });
  });

  it('a saved value outside its range shows as used as saved, and an edit of another field leaves it', async () => {
    withNumerics();
    window.__CFD_STUDY_STATE__ = study({}, { p_tolerance: 0.01 });
    const view = renderPanel();
    expect(view.container.querySelector('[data-schema-saved-outside="p_tolerance"]')?.textContent).toBe('Saved as 1e-2, outside 1e-12 to 1e-3. It is used as saved.');
    fireEvent.change(screen.getByLabelText('Momentum convection', { selector: 'select' }), { target: { value: '0' } });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalled());
    for (const [patch] of (window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mock.calls) {
      expect(Object.keys(patch as object)).not.toContain('p_tolerance');
    }
  });
});
