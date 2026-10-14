import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../../../src/panels/legacyBridge';
import { SimulationDefaults } from '../../../src/panels/simulation/SimulationPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import { shownSettingsSchema, solverLine } from './StudySettings';

// Heat Transfer's study settings in the core's study panel: the physics rows from the
// analysis's schema, temperatures in the project's units, and which solver runs.

const settingsSchema = {
  type: 'object',
  properties: {
    gravity: {
      type: 'string',
      title: 'Gravity',
      enum: ['off', '-z', '+z', '-y', '+y', '-x', '+x', 'custom'],
      default: '-z',
      'x-cfddesk': { group: 'gravity', enum_labels: ['Off', '−Z (down along Z)', '+Z', '−Y (down along Y)', '+Y', '−X', '+X', 'Custom direction'] },
    },
    gravity_magnitude: { type: 'number', title: 'Gravity magnitude', default: 9.80665, 'x-cfddesk': { quantity: 'acceleration', group: 'gravity' } },
    density_model: {
      type: 'string',
      title: 'Density',
      enum: ['auto', 'perfect_gas', 'boussinesq', 'constant'],
      default: 'auto',
      'x-cfddesk': {
        group: 'fluid',
        enum_labels: ['From the fluid (gas: perfect gas, liquid: Boussinesq)', 'Incompressible perfect gas', 'Boussinesq', 'Constant density'],
      },
    },
    reference_temperature: { type: 'number', title: 'Reference temperature', default: 293.15, 'x-cfddesk': { quantity: 'temperature', group: 'fluid' } },
  },
};
const numericsSchema = {
  type: 'object',
  properties: {
    numerics_preset: { type: 'string', title: 'Numerics', enum: ['robust', 'accurate'], default: 'robust', 'x-cfddesk': { enum_labels: ['Robust', 'Accurate'] } },
  },
};

function study(overrides: Partial<StudyState> = {}, record: Record<string, unknown> = {}): StudyState {
  return {
    has_study: true,
    id: 'sim_1',
    name: 'Heat transfer 1',
    analysis: 'Heat transfer',
    analysis_type: 'heat_transfer_steady',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    record: { id: 'sim_1', gravity: '-z', reference_temperature: 293.15, ...record },
    ...overrides,
  };
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
          family: { key: 'heat_transfer' },
          schema: settingsSchema,
          numerics_schema: numericsSchema,
          ui: { study_settings: 'heat_transfer.study', run_settings: 'heat_transfer.run' },
        },
        {
          key: 'heat_transfer_transient',
          label: 'Heat Transfer (Transient)',
          time_dependency: 'transient',
          family: { key: 'heat_transfer' },
          schema: settingsSchema,
          numerics_schema: numericsSchema,
          ui: { study_settings: 'heat_transfer.study', run_settings: 'heat_transfer.run' },
        },
      ],
    },
  });
  window.__CFD_STUDY_STATE__ = study();
  window.__CFD_STUDY_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_TIME__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'heat_transfer'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('heat_transfer');
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_PLUGINS_READY__;
  localStorage.clear();
});

function renderPanel() {
  return render(<SimulationDefaults panelId="panel-study-settings" scope="p:proj/s:sim_1" />);
}

describe('Heat Transfer study settings', () => {
  it('says which solver runs and shows the physics rows', () => {
    renderPanel();
    expect(screen.getByText(/Solves buoyant flow of one fluid with buoyantSimpleFoam/)).toBeInTheDocument();
    const gravity = screen.getByLabelText('Gravity', { selector: 'select' }) as HTMLSelectElement;
    expect(gravity.options[gravity.selectedIndex].text).toBe('−Z (down along Z)');
    expect(screen.getByText('Gravity magnitude')).toBeInTheDocument();
    const density = screen.getByLabelText('Density', { selector: 'select' }) as HTMLSelectElement;
    expect([...density.options].map((o) => o.text)).toContain('Boussinesq');
    expect((screen.getByLabelText('Time dependency') as HTMLSelectElement).value).toBe('Steady-state');
    expect(screen.getByText('SIMPLE')).toBeInTheDocument();
    expect(screen.getByText('Numerics')).toBeInTheDocument();
  });

  it('shows the reference temperature in °C in a metric project and saves K', async () => {
    renderPanel();
    const t = screen.getByLabelText('Reference temperature', { selector: 'input' }) as HTMLInputElement;
    expect(Number(t.value)).toBeCloseTo(20, 6);
    expect(screen.getAllByText('°C').length).toBeGreaterThan(0);
    fireEvent.change(t, { target: { value: '25' } });
    fireEvent.blur(t);
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalled());
    const patch = (window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Record<string, number>;
    expect(patch.reference_temperature).toBeCloseTo(298.15, 6);
  });

  it('hides the gravity magnitude while gravity is off and saves a new direction', async () => {
    window.__CFD_STUDY_STATE__ = study({}, { gravity: 'off' });
    renderPanel();
    expect(screen.queryByText('Gravity magnitude')).toBeNull();
    const gravity = screen.getByLabelText('Gravity', { selector: 'select' }) as HTMLSelectElement;
    const down = [...gravity.options].find((o) => o.text === '−Y (down along Y)')!;
    fireEvent.change(gravity, { target: { value: down.value } });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith(expect.objectContaining({ gravity: '-y' })));
  });

  it('switches to transient through the runtime and names its solver', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Time dependency'), { target: { value: 'Transient' } });
    expect(window.__CFD_STUDY_TIME__).toHaveBeenCalledWith('Transient');
    const next = study({ time_dependency: 'Transient', algorithm: 'PIMPLE', analysis_type: 'heat_transfer_transient' });
    window.__CFD_STUDY_STATE__ = next;
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:study', { detail: next }));
    });
    expect(screen.getByText(/with buoyantPimpleFoam/)).toBeInTheDocument();
    expect(screen.getByText('PIMPLE')).toBeInTheDocument();
  });
});

describe('helpers', () => {
  it('solverLine and shownSettingsSchema', () => {
    expect(solverLine(false)).toContain('buoyantSimpleFoam');
    expect(solverLine(true)).toContain('buoyantPimpleFoam');
    const off = shownSettingsSchema(settingsSchema as never, { gravity: 'off' });
    expect(Object.keys(off.properties || {})).not.toContain('gravity_magnitude');
    expect(Object.keys(shownSettingsSchema(settingsSchema as never, {}).properties || {})).toContain('gravity_magnitude');
  });
});
