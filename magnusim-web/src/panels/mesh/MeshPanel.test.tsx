import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshJobState } from '../legacyBridge';
import { MeshInspect, MeshSettings, formValuesFrom, generateButtonFor, queuedLine, settingsFrom } from './MeshPanel';

const workerRpc = vi.fn(async () => ({ ok: true }));
vi.mock('../../api/workerRpc', () => ({ workerRpc: (...args: unknown[]) => workerRpc(...args) }));

vi.mock('../scope', async () => {
  const real = await vi.importActual<typeof import('../scope')>('../scope');
  return {
    ...real,
    useRegistryReady: () => ({
      mesher: [
        {
          key: 'standard',
          label: 'Standard',
          schema: {
            type: 'object',
            properties: {
              fineness: {
                type: 'integer',
                title: 'Fineness',
                default: 5,
                minimum: 1,
                maximum: 10,
                'x-cfddesk': { widget: 'range' },
              },
              add_layers: { type: 'boolean', title: 'Automatic boundary layers', default: true },
              hex_element_core: { type: 'boolean', title: 'Hex element core', default: true },
              gap_refinement_factor: {
                type: 'number',
                title: 'Gap refinement factor',
                default: 0.05,
                'x-cfddesk': { advanced: true },
              },
            },
          },
        },
        { key: 'cfmesh', label: 'cfMesh (legacy)', schema: { type: 'object', properties: {} } },
      ],
    }),
  };
});

const meshDoc = {
  mesh: {
    id: 'm1',
    name: 'Mesh 1',
    n_cells: 677353,
    n_points: 296017,
    ui_mesh_engine: 'standard',
    settings: {
      fineness: 7,
      automatic_boundary_layers: false,
      hex_element_core: true,
      sizing: 'Automatic',
      advanced: { mesh_engine: 'standard', gap_refinement_factor: 0.1, small_feature_suppression: '4.227e-6' },
    },
  },
};

function jobState(partial: Partial<MeshJobState>): MeshJobState {
  return {
    mesh_id: 'm1',
    job_mesh_id: 'm1',
    name: 'Mesh 1',
    can_delete: true,
    mine: true,
    phase: 'idle',
    status: 'idle',
    stage_text: '',
    error: '',
    n_cells: null,
    n_points: null,
    counts_source: 'polyMesh',
    meta_bits: [],
    started_at: null,
    finished_at: null,
    elapsed_ms: null,
    generate_kind: 'generate',
    ...partial,
  };
}

function publishJob(partial: Partial<MeshJobState>) {
  const detail = jobState(partial);
  window.__CFD_MESH_JOB__ = detail;
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:mesh-job', { detail }));
  });
}

beforeEach(() => {
  workerRpc.mockClear();
  delete window.__CFD_MESH_JOB__;
  delete window.__CFD_MESH_COPY__;
  window.__CFD_MESH_GENERATE_CLICK__ = vi.fn(async () => ({}));
  window.__CFD_DELETE_MESH__ = vi.fn(async () => ({}));
  window.__CFD_MESH_RENAME__ = vi.fn(async (name: string) => name);
  window.__CFD_MESH_RESTORE_DEFAULTS__ = vi.fn(async () => ({}));
  window.__CFD_MESH_OPEN_SETTINGS__ = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/mesh')) return new Response(JSON.stringify(meshDoc), { status: 200 });
      if (url.includes('/api/project/tree')) {
        return new Response(
          JSON.stringify({ geometries: [{ studies: [{ meshes: [meshDoc.mesh] }] }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settings mapping', () => {
  it('reads disk settings into schema keys and treats the legacy sfs default as automatic', () => {
    const values = formValuesFrom(meshDoc.mesh.settings);
    expect(values).toMatchObject({
      fineness: 7,
      add_layers: false,
      hex_element_core: true,
      gap_refinement_factor: 0.1,
      small_feature_suppression: '',
    });
  });

  it('writes every advanced key back so the server never has to merge', () => {
    const body = settingsFrom(
      { fineness: 3, add_layers: true, small_feature_suppression: ' 0.002 ', gap_refinement_factor: 0.2 },
      'cfmesh',
    );
    expect(body).toMatchObject({
      fineness: 3,
      automatic_boundary_layers: true,
      ui_mesh_engine: 'cfmesh',
      advanced: {
        mesh_engine: 'cfmesh',
        small_feature_suppression: '0.002',
        small_feature_suppression_unit: 'm',
        gap_refinement_factor: 0.2,
      },
    });
    expect(body.sizing).toBe('Automatic');
  });

  it('labels the Generate button by queue state', () => {
    expect(generateButtonFor('generate').text).toBe('Generate');
    expect(generateButtonFor('generating')).toMatchObject({ text: 'Generating…', disabled: true });
    expect(generateButtonFor('queued').text).toBe('Remove from queue');
    expect(generateButtonFor('queue').text).toBe('Add to queue');
  });
});

describe('MeshSettings', () => {
  it('renders the V0.1.0 rows: name, Algorithm/Sizing, slider, toggles, Advanced with engine, Generate, foot', async () => {
    const { container } = render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    expect(container.querySelector('[data-mesh-algorithm="1"]')?.textContent).toBe('Standard');
    expect(screen.getByText('Sizing').nextElementSibling?.textContent).toBe('Automatic');
    const engine = screen.getByLabelText('Mesh engine') as HTMLSelectElement;
    expect(engine.getAttribute('data-mesh-engine')).toBe('1');
    expect(engine.querySelector('option[value="cfmesh"]')).not.toBeNull();
    expect(engine.closest('details.mesh-advanced')).not.toBeNull();
    expect(container.querySelectorAll('details.mesh-advanced')).toHaveLength(1);
    const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
    expect(slider.type).toBe('range');
    await waitFor(() => expect(slider.value).toBe('7'));
    expect(screen.getByText('COARSE')).toBeInTheDocument();
    expect(screen.getByLabelText('Automatic boundary layers')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Advanced settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toHaveAttribute('data-mesh-generate', '1');
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('routes Generate through the runtime bridge with the current settings', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('7'));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(window.__CFD_MESH_GENERATE_CLICK__).toHaveBeenCalled());
    const call = (window.__CFD_MESH_GENERATE_CLICK__ as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      mesh_id: string;
      settings: Record<string, unknown>;
    };
    expect(call.mesh_id).toBe('m1');
    expect(call.settings).toMatchObject({ fineness: 7, automatic_boundary_layers: false });
    expect(workerRpc).toHaveBeenCalledWith('mesh.set', expect.anything());
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const posts = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/mesh/generate'));
    expect(posts).toHaveLength(0);
  });

  it('shows generating, then ready with cells and nodes, from cfd:mesh-job', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    publishJob({
      phase: 'generating',
      status: 'running',
      stage_text: 'Meshing the surface',
      started_at: Date.now() - 23_000,
      generate_kind: 'generating',
    });
    expect(screen.getByText('Generating mesh')).toBeInTheDocument();
    expect(screen.getByText('Meshing the surface…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeDisabled();
    publishJob({
      phase: 'ready',
      status: 'done',
      n_cells: 677353,
      n_points: 296017,
      meta_bits: ['Standard', 'hex element core', 'surface size 6.03 mm'],
      started_at: Date.now() - 23_000,
      finished_at: Date.now(),
    });
    expect(screen.getByText('Mesh ready')).toBeInTheDocument();
    expect(screen.getByText('677,353 cells / 296,017 nodes')).toBeInTheDocument();
    expect(screen.getByText(/Standard · hex element core · surface size 6\.03 mm · 0:23/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps the engine select reachable on an engine with no settings schema', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    const engine = (await screen.findByLabelText('Mesh engine')) as HTMLSelectElement;
    fireEvent.change(engine, { target: { value: 'cfmesh' } });
    const again = (await screen.findByLabelText('Mesh engine')) as HTMLSelectElement;
    expect(again.value).toBe('cfmesh');
    expect(again.closest('details.mesh-advanced')).not.toBeNull();
    expect(screen.queryByText('No settings on this schema.')).toBeNull();
  });

  it('says Queued behind the running job, and the button removes it from the queue', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    publishJob({
      phase: 'queued',
      status: 'idle',
      generate_kind: 'queued',
      queue: { position: 2, behind: 'Mesh 1 in Project A' },
    });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Waiting for Mesh 1 in Project A to finish. Number 2 in the queue.')).toBeInTheDocument();
    expect(screen.queryByText('Generating mesh')).toBeNull();
    const button = screen.getByRole('button', { name: 'Remove from queue' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(window.__CFD_MESH_GENERATE_CLICK__).toHaveBeenCalled());
    expect(queuedLine({ position: 1, behind: 'Run 1' })).toBe('Waiting for Run 1 to finish.');
  });

  it('ignores job state for a different mesh', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    publishJob({ mesh_id: 'other', phase: 'failed', error: 'boom' });
    expect(screen.queryByText('Mesh failed')).toBeNull();
  });

  it('renames through the bridge', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Rename mesh' }));
    const input = screen.getByLabelText('Mesh name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Fine mesh' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(window.__CFD_MESH_RENAME__).toHaveBeenCalledWith('Fine mesh'));
    expect(screen.getByText('Fine mesh')).toBeInTheDocument();
  });
});

describe('MeshInspect', () => {
  it('shows counts, Settings and Delete for a generated mesh', async () => {
    window.__CFD_MESH_JOB__ = jobState({ phase: 'ready', n_cells: 677353, n_points: 296017 });
    render(<MeshInspect panelId="panel-mesh-inspect" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('677,353 cells · 296,017 nodes')).toBeInTheDocument());
    expect(screen.getByText('Generated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(window.__CFD_MESH_OPEN_SETTINGS__).toHaveBeenCalledWith('m1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(window.__CFD_DELETE_MESH__).toHaveBeenCalled();
  });
});
