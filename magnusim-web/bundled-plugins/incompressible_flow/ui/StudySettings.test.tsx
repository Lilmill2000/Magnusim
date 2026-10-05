import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../../../src/panels/legacyBridge';
import { SimulationDefaults } from '../../../src/panels/simulation/SimulationPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { numericsData, turbulenceKey } from './StudySettings';

// Incompressible Flow's study settings in the core's study panel (H10: the
// component is the plugin's, the chrome around it the core's).

const settingsSchema = {
  type: 'object',
  properties: {
    turbulence_model: {
      type: 'string',
      title: 'Turbulence model',
      enum: ['laminar', 'kEpsilon', 'kOmegaSST', 'LRR', 'SSG'],
      default: 'kOmegaSST',
      description: 'Which turbulence closure the solver uses.',
      'x-cfddesk': {
        enum_labels: ['Laminar', 'k-epsilon', 'k-omega SST', 'LRR (Reynolds stress)', 'SSG (Reynolds stress)'],
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
      'k-epsilon',
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

  it('switches time dependency through the runtime, and a transient study hides SIMPLE numerics', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Time dependency'), { target: { value: 'Transient' } });
    expect(window.__CFD_STUDY_TIME__).toHaveBeenCalledWith('Transient');
    publish(study({ time_dependency: 'Transient', algorithm: 'PIMPLE' }));
    expect(screen.getByText('PIMPLE')).toBeInTheDocument();
    expect(screen.queryByText('Residual U')).toBeNull();
    expect(screen.getByText(/PIMPLE correctors from each run/)).toBeInTheDocument();
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
});
