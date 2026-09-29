import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../legacyBridge';
import { pluginUiFor, unregisterPlugin, type StudySettingsProps } from '../../plugin-api';
import { useProjectStore } from '../../store/project';
import { SimulationDefaults } from './SimulationPanel';

// The study panel is core chrome around the analysis's own settings (H10).
const diffusion = {
  key: 'toy_steady',
  label: 'Toy diffusion',
  time_dependency: 'steady',
  family: { key: 'toy', label: 'Toy', title: 'Toy', description: '', tags: [] },
  algorithm_label: 'Laplacian',
  schema: {
    type: 'object',
    properties: { diffusivity: { type: 'number', title: 'Diffusivity', default: 0 } },
  },
};

function study(overrides: Partial<StudyState> = {}): StudyState {
  return {
    has_study: true,
    id: 'sim_1',
    name: 'Toy study',
    analysis: 'Toy',
    analysis_type: 'toy_steady',
    time_dependency: 'Steady-state',
    algorithm: '',
    record: { id: 'sim_1', diffusivity: 0.5 },
    ...overrides,
  };
}

function setRows(rows: Array<Record<string, unknown>>) {
  useProjectStore.setState({ projectId: 'proj', registry: { analysis: rows } as never });
}

beforeEach(() => {
  window.__CFD_STUDY_STATE__ = study();
  window.__CFD_STUDY_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_TIME__ = vi.fn(async () => ({}));
  window.__CFD_STUDY_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
});

afterEach(() => {
  cleanup();
  unregisterPlugin('toy');
  delete window.__CFD_STUDY_STATE__;
  delete window.__CFD_PLUGINS_READY__;
});

const renderPanel = () => render(<SimulationDefaults panelId="panel-incompressible-defaults" scope="p:proj/s:sim_1" />);

describe('study panel settings slot', () => {
  it('draws an analysis without its own settings from its schemas', async () => {
    setRows([diffusion]);
    renderPanel();
    expect(screen.getByText('Toy study')).toBeInTheDocument();
    expect(screen.getByText('Laplacian')).toBeInTheDocument();
    // No steady/transient sibling in its family: no Time dependency switch.
    expect(screen.queryByLabelText('Time dependency')).toBeNull();
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: '0.75' } });
    fireEvent.blur(field);
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ diffusivity: 0.75 }));
  });

  it('offers the time dependency when the family has both', () => {
    setRows([diffusion, { ...diffusion, key: 'toy_transient', time_dependency: 'transient' }]);
    renderPanel();
    fireEvent.change(screen.getByLabelText('Time dependency'), { target: { value: 'Transient' } });
    expect(window.__CFD_STUDY_TIME__).toHaveBeenCalledWith('Transient');
  });

  it('shows the plugin component the analysis names, with the study and a save', async () => {
    setRows([{ ...diffusion, ui: { study_settings: 'toy.study' } }]);
    function ToySettings({ study: s, row, save }: StudySettingsProps) {
      return (
        <button type="button" data-toy="1" onClick={() => void save({ diffusivity: 2 })}>
          {String(row?.key)} {String((s.record || {}).diffusivity)}
        </button>
      );
    }
    pluginUiFor('toy').registerStudySettings('toy.study', ToySettings);
    renderPanel();
    const own = screen.getByText('toy_steady 0.5');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(own);
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ diffusivity: 2 }));
  });

  it('waits for plugin UIs instead of flashing the generic form, then falls back', () => {
    setRows([{ ...diffusion, ui: { study_settings: 'toy.missing' } }]);
    delete window.__CFD_PLUGINS_READY__;
    renderPanel();
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => {
      window.__CFD_PLUGINS_READY__ = true;
      window.dispatchEvent(new Event('cfd:plugins-ready'));
    });
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('removes a disabled plugin component (its ledger), leaving the generic form', () => {
    setRows([{ ...diffusion, ui: { study_settings: 'toy.study' } }]);
    pluginUiFor('toy').registerStudySettings('toy.study', () => <span>own settings</span>);
    renderPanel();
    expect(screen.getByText('own settings')).toBeInTheDocument();
    act(() => unregisterPlugin('toy'));
    expect(screen.queryByText('own settings')).toBeNull();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows a failed save under the settings', async () => {
    setRows([diffusion]);
    window.__CFD_STUDY_UPDATE__ = vi.fn(async () => {
      throw new Error('Could not save');
    });
    renderPanel();
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: '0.9' } });
    fireEvent.blur(field);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  });
});
