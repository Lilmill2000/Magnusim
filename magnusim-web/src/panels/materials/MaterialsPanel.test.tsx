import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishBodySelection } from '../../viewer/pick';
import { MaterialsPanel, airRecord, fluidKindOf, studyFluid, toggleVolume } from './MaterialsPanel';

type Rpc = (method: string, params?: { body?: { air?: Record<string, unknown> } }) => Promise<unknown>;
const workerRpc = vi.fn<Rpc>(async (_method, params) => ({ air: params?.body?.air, materials: [params?.body?.air] }));
vi.mock('../../api/workerRpc', () => ({
  workerRpc: (method: string, params?: { body?: { air?: Record<string, unknown> } }) => workerRpc(method, params),
}));

const stored = {
  id: 'mat1',
  name: 'Air',
  kinematic_viscosity: 1.529e-5,
  density: 1.196,
  assigned_volumes: ['Body1'],
  body_ids: ['Body1'],
  simulation_id: 's1',
};

beforeEach(() => {
  workerRpc.mockClear();
  window.__CFD_GEOMETRY_BODIES__ = () => ['Body1', 'Body2'];
  window.__CFD_MATERIAL_APPLY__ = vi.fn();
  window.__CFD_MATERIAL_DELETE__ = vi.fn(async () => ({}));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/materials')) {
        return new Response(JSON.stringify({ materials: [stored], air: stored }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
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
  it('tells Air, Water and custom fluids apart and finds the study fluid', () => {
    expect(fluidKindOf({ name: 'Air' })).toBe('Air');
    expect(fluidKindOf({ name: 'Water' })).toBe('Water');
    expect(fluidKindOf({ name: 'Oil', library: 'CUSTOM' })).toBe('Custom');
    expect(fluidKindOf({ name: 'Oil' })).toBe('Custom');
    expect(fluidKindOf(null)).toBe('Air');
    expect(studyFluid([{ name: 'Air' }, { name: 'Water', assigned_volumes: ['Body1'] }])?.name).toBe('Water');
    expect(studyFluid([{ name: 'X' }, { name: 'Air' }])?.name).toBe('Air');
  });

  it('toggles one body', () => {
    expect(toggleVolume(['Body1'], 'Body1')).toEqual([]);
    expect(toggleVolume(['Body1'], 'Body2')).toEqual(['Body1', 'Body2']);
  });

  it('writes the keys the case writer reads, aliases included', () => {
    const rec = airRecord({ id: 'm', body_ids: ['Old'] }, { nu: 2e-5, rho: 1.2, volumes: [] }, { simulation_id: 's1' }, 'now');
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
  it('shows tiny viscosity in scientific notation and offers Air, Water and a custom fluid', async () => {
    renderPanel();
    const nu = screen.getByLabelText('Kinematic viscosity') as HTMLInputElement;
    await waitFor(() => expect(nu.value).toBe('1.5290e-5'));
    const fluid = screen.getByLabelText('Fluid') as HTMLSelectElement;
    expect(fluid.value).toBe('Air');
    expect([...fluid.options].map((o) => o.text)).toEqual(['Air', 'Water', 'Custom fluid']);
    expect(screen.getByText(/Picking bodies: click a body in the viewport/)).toBeInTheDocument();
  });

  it('choosing Water saves water properties under that name', async () => {
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5290e-5'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Fluid'), { target: { value: 'Water' } });
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    expect(lastSavedAir()).toMatchObject({
      id: 'mat1',
      name: 'Water',
      library: 'WATER',
      kinematic_viscosity: 1.004e-6,
      density: 998.2,
      assigned_volumes: ['Body1'],
    });
  });

  it('a custom fluid keeps its name and typed properties', async () => {
    renderPanel();
    await waitFor(() => expect((screen.getByLabelText('Kinematic viscosity') as HTMLInputElement).value).toBe('1.5290e-5'));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Fluid'), { target: { value: 'Custom' } });
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
    await waitFor(() => expect(lastSavedAir()).toMatchObject({ name: 'Glycol mix', library: 'CUSTOM', density: 1070 }));
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
