import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../legacyBridge';
import { pluginUiFor, unregisterPlugin, type StudySettingsProps } from '../../plugin-api';
import { useProjectStore } from '../../store/project';
import { SimulationDefaults, SimulationHub } from './SimulationPanel';

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

const renderPanel = () => render(<SimulationDefaults panelId="panel-study-settings" scope="p:proj/s:sim_1" />);

describe('Create Simulation time dependency', () => {
  afterEach(() => {
    delete window.__CFD_CREATE_PICK_ANALYSIS__;
  });

  it('keeps a steady-only analysis instead of jumping to another family', () => {
    // Transient used to pick the first transient analysis of any family, so a
    // steady-only plugin analysis turned into an Incompressible study.
    const fam = (key: string) => ({ key, label: key, title: key, description: '', tags: [] });
    useProjectStore.setState({
      projectId: 'proj',
      registry: {
        analysis: [
          { key: 'flow_steady', label: 'Flow', time_dependency: 'steady', family: fam('flow') },
          { key: 'flow_transient', label: 'Flow', time_dependency: 'transient', family: fam('flow') },
          { ...diffusion, label: 'Toy diffusion' },
        ],
        default_analysis: { steady: 'flow_steady', transient: 'flow_transient' },
      } as never,
    });
    const picked: string[] = [];
    window.__CFD_CREATE_PICK_ANALYSIS__ = (row: { key: string }) => picked.push(row.key);
    render(<SimulationHub panelId="cs-type-list" scope="p:proj" />);
    fireEvent.click(screen.getByText('Toy diffusion'));
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:create-time-dep', { detail: { value: 'Transient' } }));
    });
    expect(picked[picked.length - 1]).toBe('toy_steady');
    expect(document.querySelector('[data-analysis-key="toy_steady"]')?.className).toMatch(/is-selected/);
    // A family with both still swaps to its own sibling.
    fireEvent.click(document.querySelector('[data-analysis-key="flow_steady"]') as HTMLElement);
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:create-time-dep', { detail: { value: 'Transient' } }));
    });
    expect(picked[picked.length - 1]).toBe('flow_transient');
  });
});

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

  it('says a study needs its plugin instead of showing another analysis', () => {
    // The study's analysis is not installed (its plugin is off); another one is.
    // It used to fall back to the default (or first) analysis's settings, and a
    // save wrote that analysis's fields into this study.
    setRows([{ ...diffusion, key: 'other_steady', family: { ...diffusion.family, key: 'other' } }]);
    window.__CFD_STUDY_STATE__ = study({ analysis_type: 'toy_steady' });
    renderPanel();
    const note = document.querySelector('[data-study-missing="1"]');
    expect(note).toHaveTextContent("This simulation's analysis is not available: its plugin is off or did not load.");
    expect(screen.getByRole('button', { name: 'Open Settings → Plugins' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('names the required plugin that failed to load', () => {
    useProjectStore.setState({
      projectId: 'proj',
      registry: {
        analysis: [],
        required_missing: [{ key: 'flow', name: 'Flow', error: 'boom' }],
        default_analysis: null,
      } as never,
    });
    // A study saved before analysis keys (no analysis_type): the default analysis, not installed.
    window.__CFD_STUDY_STATE__ = study({ analysis_type: '' });
    renderPanel();
    expect(document.querySelector('[data-study-missing="1"]')).toHaveTextContent(
      'Flow failed to load, so this simulation can\'t be set up or run.',
    );
  });

  it('reads a study saved before analysis keys as the default analysis', () => {
    useProjectStore.setState({
      projectId: 'proj',
      registry: {
        analysis: [diffusion, { ...diffusion, key: 'toy_transient', time_dependency: 'transient' }],
        default_analysis: { steady: 'toy_steady', transient: 'toy_transient', aliases: ['toy'] },
      } as never,
    });
    window.__CFD_STUDY_STATE__ = study({ analysis_type: 'toy', time_dependency: 'Transient' });
    renderPanel();
    expect(document.querySelector('[data-study-missing="1"]')).toBeNull();
    expect(screen.getByLabelText('Time dependency')).toHaveValue('Transient');
  });

  it('shows a transient analysis its own numerics (the schema decides)', () => {
    // The generic form used to hide numerics for every transient analysis, a rule
    // of Incompressible Flow's (its PIMPLE settings are run settings).
    const numerics = { type: 'object', properties: { relax: { type: 'number', title: 'Relaxation', default: 0.7 } } };
    setRows([{ ...diffusion, key: 'toy_transient', time_dependency: 'transient', numerics_schema: numerics }]);
    window.__CFD_STUDY_STATE__ = study({ analysis_type: 'toy_transient', time_dependency: 'Transient' });
    renderPanel();
    expect(screen.getByText('Relaxation')).toBeInTheDocument();
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
