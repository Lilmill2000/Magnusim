import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshJobState } from '../legacyBridge';
import {
  MeshInspect,
  MeshSettings,
  STOPPED_LINE,
  editedKeys,
  editsAfterSave,
  editsAfterSync,
  formValuesFrom,
  generateButtonFor,
  mergeEdits,
  queuedLine,
  settingsFrom,
} from './MeshPanel';

const workerRpc = vi.fn(async () => ({ ok: true }));
vi.mock('../../api/workerRpc', () => ({ workerRpc: (...args: unknown[]) => workerRpc(...args) }));
const confirmAction = vi.fn(async (_o?: unknown) => true);
vi.mock('../../workbench/dialogs', () => ({ confirmAction: (o?: unknown) => confirmAction(o) }));

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
        {
          key: 'cfmesh',
          label: 'cfMesh (legacy)',
          schema: {
            type: 'object',
            properties: {
              fineness: { type: 'integer', title: 'Fineness', default: 5, minimum: 1, maximum: 10 },
              add_layers: { type: 'boolean', title: 'Automatic boundary layers', default: true },
              physics_based: { type: 'boolean', title: 'Physics-based meshing', default: true },
              hex_element_core: { type: 'boolean', title: 'Hex element core', default: true },
            },
          },
        },
        { key: 'bare', label: 'Bare', schema: { type: 'object', properties: {} } },
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
  confirmAction.mockReset();
  confirmAction.mockResolvedValue(true);
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

  it("keeps a plugin mesher's own settings, at their defaults until changed", () => {
    const schema = {
      type: 'object' as const,
      properties: {
        fineness: { type: 'integer' as const, default: 5 },
        surface_bias: { type: 'number' as const, default: 1.5 },
        smoothing: { type: 'boolean' as const, default: true },
      },
    };
    const body = settingsFrom({ fineness: 4, surface_bias: 2.25 }, 'example_extra_mesher', schema);
    // Core keys stay in their own fields; the mesher's own keys are saved as given.
    expect(body.fineness).toBe(4);
    expect(body.mesher_settings).toEqual({ surface_bias: 2.25, smoothing: true });
    const back = formValuesFrom({ fineness: 4, mesher_settings: body.mesher_settings as Record<string, unknown> });
    expect(back).toMatchObject({ fineness: 4, surface_bias: 2.25, smoothing: true });
    // A core key never comes back from the bag.
    expect(formValuesFrom({ fineness: 4, mesher_settings: { fineness: 9 } }).fineness).toBe(4);
  });

  it('keeps the keys the user changed over a later load', () => {
    const shown = { fineness: 5, hex_element_core: true, add_layers: true };
    expect(editedKeys(shown, { ...shown, fineness: 2 })).toEqual(['fineness']);
    expect(editedKeys({}, { fineness: 2 })).toEqual([]);
    const stored = { fineness: 7, hex_element_core: false, add_layers: true };
    expect(mergeEdits(stored, { ...shown, fineness: 2 }, ['fineness'])).toEqual({
      fineness: 2,
      hex_element_core: false,
      add_layers: true,
    });
  });

  it('forgets an edit once a save stored it, and keeps one changed again since (C2 finding 7)', () => {
    const saved = { fineness: 3, add_layers: true };
    expect([...editsAfterSave(['fineness', 'add_layers'], saved, { fineness: 3, add_layers: false })]).toEqual(['add_layers']);
    expect([...editsAfterSave(['fineness'], saved, saved)]).toEqual([]);
  });

  it("drops an edit of what the Assistant changed and keeps the person's edits of the rest", () => {
    const before = { fineness: 7, add_layers: false };
    const after = { fineness: 9, add_layers: false };
    expect([...editsAfterSync(['fineness', 'add_layers'], before, after)]).toEqual(['add_layers']);
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

  it('keeps a fineness changed before the stored settings load, saves nothing until then, and generates with it', async () => {
    let land: () => void = () => {};
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/mesh') && !url.includes('/generate')) {
        await new Promise<void>((r) => {
          land = r;
        });
      }
      return base(input);
    });
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
    expect(slider.value).toBe('5');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(slider.value).toBe('3');
    // The change would be saved now; the form still shows defaults for the rest.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(workerRpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await act(async () => {
      land();
    });
    // The stored layers (off) come in; the fineness stays the user's.
    await waitFor(() => expect(screen.getByLabelText('Automatic boundary layers')).toHaveAttribute('aria-pressed', 'false'));
    expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('3');
    await waitFor(() => expect(window.__CFD_MESH_GENERATE_CLICK__).toHaveBeenCalled());
    const call = (window.__CFD_MESH_GENERATE_CLICK__ as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      settings: Record<string, unknown>;
    };
    expect(call.settings).toMatchObject({ fineness: 3, automatic_boundary_layers: false });
    const saves = workerRpc.mock.calls.map((c) => (c as unknown[])[1] as { body: { settings: Record<string, unknown> } });
    expect(saves.length).toBeGreaterThan(0);
    for (const s of saves) expect(s.body.settings).toMatchObject({ fineness: 3, automatic_boundary_layers: false });
  });

  it('shows the stored settings over earlier changes after Restore defaults', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe('7'));
    fireEvent.change(slider, { target: { value: '3' } });
    expect(slider.value).toBe('3');
    fireEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    await waitFor(() => expect(window.__CFD_MESH_RESTORE_DEFAULTS__).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('7'));
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

  it('a mesh whose checkMesh failed Generate shows the failed checks once and its worst cells (D1)', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    const reason = 'checkMesh failed 2 checks: 8 cells with a negative volume, 84 faces over 90° non-orthogonal.';
    publishJob({
      phase: 'failed',
      status: 'failed',
      error: reason,
      quality: {
        ok: false,
        n_failed: 2,
        failed: [
          { check: 'negative_volume', count: 8, unit: 'cells', accepted: false },
          { check: 'non_orthogonality', count: 84, unit: 'faces', accepted: false },
        ],
        max_non_orthogonality: 180,
        max_skewness: 29.2463,
        max_aspect_ratio: 4.45,
      },
    });
    expect(screen.getByText('Mesh failed')).toBeInTheDocument();
    expect(screen.getAllByText(reason)).toHaveLength(1);
    const lines = [...document.querySelectorAll('[data-mesh-quality] > div')].map((d) => d.textContent);
    expect(lines).toEqual(['Worst cells: 180° non-orthogonal, skewness 29, aspect ratio 4.5']);
  });

  it('shows Stop while this mesh generates: it asks, POSTs /api/mesh/stop, and the status says Stopped', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    publishJob({ phase: 'generating', status: 'running', stage_text: 'Meshing the surface', started_at: Date.now() - 5_000, generate_kind: 'generating' });
    const stop = screen.getByRole('button', { name: 'Stop' });
    fireEvent.click(stop);
    await waitFor(() =>
      expect(confirmAction).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Stop meshing "Mesh 1"?', copy: 'What it made so far is discarded.', yes: 'Stop', no: 'Keep meshing' }),
      ),
    );
    const posted = () =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url, init]) => String(url) === '/api/mesh/stop' && (init as RequestInit)?.method === 'POST');
    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(JSON.parse(String((posted()[0][1] as RequestInit).body))).toEqual({ project_id: 'p1', simulation_id: 's1', mesh_id: 'm1' });
    // The runtime follows the job's end: the panel says Stopped, and Stop goes.
    publishJob({ phase: 'stopped', status: 'stopped', started_at: Date.now() - 5_000, finished_at: Date.now(), generate_kind: 'generate' });
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText(STOPPED_LINE)).toBeInTheDocument();
    expect(screen.queryByText('Mesh ready')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled();
  });

  it('Keep meshing sends nothing', async () => {
    confirmAction.mockResolvedValue(false);
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    publishJob({ phase: 'generating', status: 'running', generate_kind: 'generating' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url) === '/api/mesh/stop');
    expect(calls).toHaveLength(0);
    expect(screen.getByText('Generating mesh')).toBeInTheDocument();
  });

  it('has no Stop while queued or once ready', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Mesh 1')).toBeInTheDocument());
    publishJob({ phase: 'queued', status: 'idle', generate_kind: 'queued', queue: { position: 1, behind: 'Run 1' } });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    publishJob({ phase: 'ready', status: 'done', n_cells: 10, n_points: 20, generate_kind: 'generate' });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('keeps the engine select reachable on an engine with no settings schema', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    const engine = (await screen.findByLabelText('Mesh engine')) as HTMLSelectElement;
    fireEvent.change(engine, { target: { value: 'bare' } });
    const again = (await screen.findByLabelText('Mesh engine')) as HTMLSelectElement;
    expect(again.value).toBe('bare');
    expect(again.closest('details.mesh-advanced')).not.toBeNull();
    expect(screen.queryByText('No settings on this schema.')).toBeNull();
  });

  it('shows cfMesh the settings its run uses, and says when Standard meshes it instead', async () => {
    // cfMesh used to show no settings at all while its run used the saved
    // fineness, layers and physics-based values.
    const { container } = render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    const engine = (await screen.findByLabelText('Mesh engine')) as HTMLSelectElement;
    fireEvent.change(engine, { target: { value: 'cfmesh' } });
    await waitFor(() => expect(container.querySelector('[data-mesh-algorithm="1"]')?.textContent).toBe('cfMesh (legacy)'));
    expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('7');
    expect(screen.getByLabelText('Automatic boundary layers')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Physics-based meshing')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hex element core'));
    await waitFor(() =>
      expect(container.querySelector('[data-mesh-algorithm="1"]')?.textContent).toBe('Standard (cfMesh needs Hex element core)'),
    );
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

  it('a save that answered forgets its edits: a later change by the Assistant shows (C2 finding 7)', async () => {
    const saves: Array<Record<string, unknown>> = [];
    window.__CFD_MESH_SAVE__ = vi.fn(async (_mesh: string | undefined, settings: Record<string, unknown>) => {
      saves.push(settings);
      return {};
    });
    try {
      render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
      const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
      await waitFor(() => expect(slider.value).toBe('7'));
      fireEvent.change(slider, { target: { value: '3' } });
      await waitFor(() => expect(saves.length).toBeGreaterThan(0));
      expect(saves.at(-1)).toMatchObject({ fineness: 3 });
      // The Assistant sets fineness 9; the window hears it.
      meshDoc.mesh.settings.fineness = 9;
      try {
        act(() => {
          window.dispatchEvent(new CustomEvent('cfd:ui-sync', { detail: { kinds: ['mesh'], ids: { mesh: ['m1'] } } }));
        });
        await waitFor(() => expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('9'));
      } finally {
        meshDoc.mesh.settings.fineness = 7;
      }
    } finally {
      delete window.__CFD_MESH_SAVE__;
    }
  });

  it("a ui_sync for this mesh keeps the person's unsaved edit of a setting the Assistant left, and shows what it changed", async () => {
    window.__CFD_MESH_SAVE__ = vi.fn(() => new Promise(() => undefined));
    try {
      render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
      const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
      await waitFor(() => expect(slider.value).toBe('7'));
      // An edit whose save never answers: still the person's.
      fireEvent.change(slider, { target: { value: '3' } });
      meshDoc.mesh.settings.automatic_boundary_layers = true;
      try {
        act(() => {
          window.dispatchEvent(new CustomEvent('cfd:ui-sync', { detail: { kinds: ['mesh'], ids: { mesh: ['m1'] } } }));
        });
        await waitFor(() => expect(screen.getByLabelText('Automatic boundary layers')).toHaveAttribute('aria-pressed', 'true'));
        expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('3');
      } finally {
        meshDoc.mesh.settings.automatic_boundary_layers = false;
      }
    } finally {
      delete window.__CFD_MESH_SAVE__;
    }
  });

  it('a ui_sync for another mesh reads nothing again', async () => {
    render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('7'));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:ui-sync', { detail: { kinds: ['mesh'], ids: { mesh: ['m2'] } } }));
      window.dispatchEvent(new CustomEvent('cfd:ui-sync', { detail: { kinds: ['bcs'], ids: { bc: ['b1'] } } }));
    });
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('a save refused as stale shows the stored values, every one', async () => {
    window.__CFD_MESH_SAVE__ = vi.fn(async () => {
      throw Object.assign(new Error('This was changed elsewhere.'), { code: 'stale_record' });
    });
    try {
      render(<MeshSettings panelId="panel-mesh-form" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
      const slider = screen.getByLabelText('Fineness') as HTMLInputElement;
      await waitFor(() => expect(slider.value).toBe('7'));
      fireEvent.change(slider, { target: { value: '3' } });
      await waitFor(() => expect(window.__CFD_MESH_SAVE__).toHaveBeenCalled());
      await waitFor(() => expect((screen.getByLabelText('Fineness') as HTMLInputElement).value).toBe('7'));
      fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(window.__CFD_MESH_GENERATE_CLICK__).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      delete window.__CFD_MESH_SAVE__;
    }
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

describe('MeshInspect stopped', () => {
  it('says Stopped for a mesh whose generate was stopped', async () => {
    window.__CFD_MESH_JOB__ = jobState({ phase: 'stopped', status: 'stopped' });
    render(<MeshInspect panelId="panel-mesh-inspect" itemId="m1" scope="p:p1/s:s1/mesh:m1" />);
    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
  });
});
