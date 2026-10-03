import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materialRecord } from '../../materialModel';
import { useProjectStore } from '../../store/project';
import { FIXTURE_MODEL, FIXTURE_REGISTRY } from '../../test/materialFixture';
import { publishBodySelection } from '../../viewer/pick';
import { MaterialsPanel, studyFluid, toggleVolume } from './MaterialsPanel';

type Rpc = (method: string, params?: { body?: { air?: Record<string, unknown> } }) => Promise<unknown>;
const workerRpc = vi.fn<Rpc>(async (_method, params) => ({ air: params?.body?.air, materials: [params?.body?.air] }));
vi.mock('../../api/workerRpc', () => ({
  workerRpc: (method: string, params?: { body?: { air?: Record<string, unknown> } }) => workerRpc(method, params),
}));

let stored: Record<string, unknown> | null;
const OLD_AIR = {
  id: 'mat1',
  name: 'Air',
  kinematic_viscosity: 1.529e-5,
  density: 1.196,
  assigned_volumes: ['Body1'],
  body_ids: ['Body1'],
  simulation_id: 's1',
};

beforeEach(() => {
  stored = OLD_AIR;
  useProjectStore.setState({ registry: FIXTURE_REGISTRY as never });
  workerRpc.mockClear();
  window.__CFD_GEOMETRY_BODIES__ = () => ['Body1', 'Body2'];
  window.__CFD_MATERIAL_APPLY__ = vi.fn();
  window.__CFD_MATERIAL_DELETE__ = vi.fn(async () => ({}));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/materials')) {
        return new Response(JSON.stringify({ materials: stored ? [stored] : [], air: stored }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ registry: null });
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(<MaterialsPanel panelId="panel-air-material" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
}

function lastSavedAir(): Record<string, unknown> {
  const call = workerRpc.mock.calls.at(-1);
  expect(call?.[0]).toBe('materials.set');
  return (call?.[1]?.body?.air || {}) as Record<string, unknown>;
}

describe('helpers', () => {
  it('finds the study fluid', () => {
    expect(studyFluid([{ name: 'Air' }, { name: 'Water', assigned_volumes: ['Body1'] }])?.name).toBe('Water');
    expect(studyFluid([{ name: 'X' }, { name: 'Air' }])?.name).toBe('Air');
  });

  it('toggles one body', () => {
    expect(toggleVolume(['Body1'], 'Body1')).toEqual([]);
    expect(toggleVolume(['Body1'], 'Body2')).toEqual(['Body1', 'Body2']);
  });

  it('writes the keys the case writer reads, aliases included', () => {
    const rec = materialRecord(
      FIXTURE_MODEL,
      { id: 'm', body_ids: ['Old'] },
      { preset: 'air', values: { nu: 2e-5, rho: 1.2 }, volumes: [] },
      { simulation_id: 's1' },
      'now',
    );
    expect(rec).toMatchObject({
      id: 'm',
      name: 'Air',
      kinematic_viscosity: 2e-5,
      density: 1.2,
      assigned_volumes: [],
      assigned_volume: null,
      body_ids: [],
      volume_ids: [],
      simulation_id: 's1',
    });
  });
});

describe('MaterialsPanel', () => {
  it("shows tiny viscosity in scientific notation and offers the model's fluids", async () => {
    renderPanel();
    const nu = screen.getByLabelText('Kinematic viscosity') as HTMLInputElement;
    await waitFor(() => expect(nu.value).toBe('1.5290e-5'));
    const fluid = screen.getByLabelText('Fluid') as HTMLSelectElement;
    expect(fluid.value).toBe('air');
    expect([...fluid.options].map((o) => o.text)).toEqual(['Air', 'Water', 'Custom fluid']);
    expect(screen.getByText('(ν) Kinematic viscosity')).toBeInTheDocument();
    expect(screen.getByText('Newtonian')).toBeInTheDocument();
    expect(screen.getByText(/Picking bodies: click a body in the viewport/)).toBeInTheDocument();
  });

  it('choosing Water saves water properties under that name', async () => {
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5290e-5'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Fluid'), { target: { value: 'water' } });
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    expect(lastSavedAir()).toMatchObject({
      id: 'mat1',
      name: 'Water',
      library: 'WATER',
      preset: 'water',
      material_model: 'newtonian_incompressible',
      kinematic_viscosity: 1.004e-6,
      nu: 1.004e-6,
      density: 998.2,
      rho: 998.2,
      assigned_volumes: ['Body1'],
    });
  });

  it("a new study's fluid shows the default preset's values", async () => {
    stored = null;
    renderPanel();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5160e-5'));
    expect((screen.getByLabelText('Fluid') as HTMLSelectElement).value).toBe('air');
    expect((screen.getByLabelText('Density') as HTMLInputElement).value).toBe('1.204');
  });

  it('an old record without numbers keeps the numbers older versions gave it', async () => {
    stored = { id: 'old', name: 'Air', library: 'DEFAULT', assigned_volumes: ['Body1'] };
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5290e-5'));
    expect((screen.getByLabelText('Density') as HTMLInputElement).value).toBe('1.196');
    expect((screen.getByLabelText('Fluid') as HTMLSelectElement).value).toBe('air');
  });

  it('says so when the analysis offers no fluids', async () => {
    useProjectStore.setState({ registry: { ...FIXTURE_REGISTRY, material: [] } as never });
    renderPanel();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Fluids are not available'));
    expect(screen.queryByLabelText('Fluid')).toBeNull();
  });

  it('a custom fluid keeps its name and typed properties', async () => {
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5290e-5'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Fluid'), { target: { value: 'custom' } });
    });
    const name = screen.getByLabelText('Fluid name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Glycol mix' } });
    await act(async () => {
      fireEvent.blur(name);
    });
    const rho = screen.getByLabelText('Density') as HTMLInputElement;
    fireEvent.change(rho, { target: { value: '1070' } });
    await act(async () => {
      fireEvent.blur(rho);
    });
    await waitFor(() =>
      expect(lastSavedAir()).toMatchObject({ name: 'Glycol mix', library: 'CUSTOM', preset: 'custom', density: 1070, rho: 1070 }),
    );
  });

  it('saves a typed viscosity through materials.set and hands it to the runtime', async () => {
    renderPanel();
    const nu = screen.getByLabelText('Kinematic viscosity') as HTMLInputElement;
    await waitFor(() => expect(nu.value).toBe('1.5290e-5'));
    fireEvent.change(nu, { target: { value: '2e-5' } });
    await act(async () => {
      fireEvent.blur(nu);
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    expect(lastSavedAir()).toMatchObject({ id: 'mat1', kinematic_viscosity: 2e-5, assigned_volumes: ['Body1'] });
    await waitFor(() => expect(window.__CFD_MATERIAL_APPLY__).toHaveBeenCalled());
  });

  it('a viewport body pick toggles that body and saves', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Assigned volumes (1)')).toBeInTheDocument());
    await act(async () => {
      publishBodySelection([{ name: 'Body2', idx: 2 }]);
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    expect(lastSavedAir().assigned_volumes).toEqual(['Body1', 'Body2']);
    expect(screen.getByText('Assigned volumes (2)')).toBeInTheDocument();
  });

  it('unassigning the last body really clears it', async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(screen.getByText('Assigned volumes (1)')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Body1' }));
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    expect(lastSavedAir()).toMatchObject({ assigned_volumes: [], body_ids: [] });
    expect(container.querySelector('[data-volume="Body1"]')?.getAttribute('data-assigned')).toBe('0');
  });

  it('Delete goes through the runtime', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(window.__CFD_MATERIAL_DELETE__).toHaveBeenCalled();
  });
});
