import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../legacyBridge';
import { useProjectStore } from '../../store/project';
import { SimulationDefaults, numericsData, turbulenceKey } from './SimulationPanel';

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
        { key: 'incompressible_steady', label: 'Incompressible Fluid Flow', schema: settingsSchema, numerics_schema: numericsSchema },
      ],
    },
  });
  window.__CFD_STUDY_STATE__ = study();
  window.__CFD_STUDY_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_TIME__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_DELETE__ = vi.fn(async () => ({}));
});

afterEach(() => {
  cleanup();
  delete window.__CFD_STUDY_STATE__;
});

function renderPanel() {
  return render(<SimulationDefaults panelId="panel-incompressible-defaults" scope="p:proj/s:sim_1" />);
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
