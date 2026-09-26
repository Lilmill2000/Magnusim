import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearTreeTransforms, pluginTreeNodes, registerPanel, registerTreeTransform } from '../plugin-api';
import { GeometryPanel } from '../panels/geometry/GeometryPanel';
import { PluginsStep } from '../panels/prefs/PluginsStep';
import { RunControl } from '../panels/run/RunControl';
import { useProjectStore } from '../store/project';
import { residualPaths, sameProjectRuns } from '../panels/run/residuals';
import { CompareLayout, FiltersPanel, InspectPoint, Legend, SavedViews, Timeline } from './FiltersPanel';

const filterSchema = {
  type: 'object',
  properties: {
    origin: { type: 'number', title: 'Origin' },
  },
};

describe('gate:h4-renders', () => {
  beforeEach(() => {
    useProjectStore.setState({
      projectId: 'proj',
      registry: {
        analysis: [
          {
            key: 'incompressible_steady',
            label: 'Incompressible',
            control_schema: filterSchema,
          },
        ],
        filter: [
          { key: 'cut_plane', label: 'Cut plane', plugin: 'builtin', schema: filterSchema },
          { key: 'probe_line', label: 'Probe line', plugin: 'demo-plugin', schema: filterSchema },
        ],
      },
    });
  });

  it('renders the results chrome when a project is open', () => {
    window.__CFD_RUN_STATE__ = {
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
      start: { visible: true, enabled: true, label: 'Start', title: 'Start the solver on this run' },
      stop: { visible: false, label: 'Stop', title: '' },
      can_delete: true,
      reason: null,
      settings: { end_time: 200, write_interval: 50 },
      transient_settings: {
        end_time: 5, write_count: 50, time_step_mode: 'adjustable', max_co: 1, delta_t: null, max_delta_t: null,
        time_scheme: 'Euler', n_outer_correctors: 1, n_correctors: 2, n_non_orth_correctors: 0,
      },
      frame_interval: 0.1,
      transient_hint: null,
      progress: { show: false, title: 'Run', line: '', elapsed: '', eta: '', meta: '', residuals: [], end: 0 },
      copy: { available: false, picking: false, note: '', sources: [] },
      mesh_ready: true,
      has_material: true,
      has_flow_driver: true,
    };
    window.__CFD_GEOMETRY_STATE__ = {
      has_geometry: true,
      id: 'geom_1',
      title: 'Vortex',
      name: 'Vortex',
      representation: 'STEP (CAD)',
      volume: 'Body1',
      can_delete: true,
    };
    render(
      <>
        <FiltersPanel />
        <Legend />
        <Timeline />
        <CompareLayout />
        <SavedViews />
        <InspectPoint />
        <RunControl panelId="panel-sim-control" scope="p:proj/s:sim_1" />
        <GeometryPanel panelId="panel-geometry" scope="p:proj/g:geom_1" />
        <PluginsStep />
      </>,
    );
    // Built-in filters keep their own FILTERS panel controls; only plugin filters get a form.
    expect(screen.queryByText('Cut plane')).toBeNull();
    expect(screen.getByText('Probe line')).toBeInTheDocument();
    expect(screen.getByText('Legend')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByLabelText('Compare run A')).toBeInTheDocument();
    expect(screen.getByText('Saved views')).toBeInTheDocument();
    expect(screen.getByText('Inspect point')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByText('STEP (CAD)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload plugins' })).toBeInTheDocument();
  });
});

describe('gate:h4-place-filters', () => {
  beforeEach(() => {
    clearTreeTransforms();
    useProjectStore.setState({ projectId: 'proj', registry: { filter: [] } });
  });

  it('renders a filters place section and drops a tree node with no project', () => {
    registerPanel({
      key: 'h4-probe',
      title: 'Probe filter',
      place: 'filters',
      Component: function Probe() {
        return <section>Probe filter</section>;
      },
    });
    registerTreeTransform(() => [
      { label: 'Kept', scope: 'p:proj/s:sim_1' },
      { label: 'Orphan' },
    ]);
    render(<FiltersPanel />);
    expect(screen.getByText('Probe filter')).toBeInTheDocument();
    expect(pluginTreeNodes('proj').map((node) => node.label)).toEqual(['Kept']);
  });

  it('draws residuals and rejects a run from another project', () => {
    expect(residualPaths([{ t: 1, U: 0.1, p: 0.01 }, { t: 2, U: 0.01, p: 0.001 }]).length).toBeGreaterThan(0);
    const foreign = sameProjectRuns(
      'proj',
      [
        { id: 'a', case_dir: 'C:/projects/proj/runs/a' },
        { id: 'b', case_dir: 'C:/projects/other/runs/b' },
      ],
      'a',
      'b',
    );
    expect(foreign.ok).toBe(false);
  });
});
