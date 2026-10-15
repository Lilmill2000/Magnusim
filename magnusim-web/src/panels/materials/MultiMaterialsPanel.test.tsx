import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSeveralMaterials, modelOf, modelsFor, roleOf, type MaterialModelRow } from '../../materialModel';
import { useProjectStore } from '../../store/project';
import { FIXTURE_MODEL, FIXTURE_REGISTRY } from '../../test/materialFixture';
import { publishBodySelection } from '../../viewer/pick';
import { MaterialsPanel } from './MaterialsPanel';
import { materialsView, withoutBodies } from './MultiMaterialsPanel';

// Host API 1.8: a study whose analysis offers several material models (a fluid
// and a solid, as heat transfer does) holds one material per group of bodies.

type Body = { materials?: Array<Record<string, unknown>>; only_id?: string; only_ids?: string[] };
type Rpc = (method: string, params?: { body?: Body }) => Promise<unknown>;
const workerRpc = vi.fn<Rpc>(async (_method, params) => ({ materials: params?.body?.materials }));
vi.mock('../../api/workerRpc', () => ({
  workerRpc: (method: string, params?: { body?: Body }) => workerRpc(method, params),
}));

const SOLID: MaterialModelRow = {
  key: 'fx_solid',
  label: 'Solid',
  role: 'solid',
  schema: {
    properties: {
      k: { title: '(k) Thermal conductivity', default: 167, minimum: 0, 'x-cfddesk': { quantity: 'thermal_conductivity' } },
    },
  },
  library: [
    { key: 'al', name: 'Aluminium 6061', values: { k: 167 }, library: 'AL', codes: ['AL', 'DEFAULT'] },
    { key: 'cu', name: 'Copper', values: { k: 398 }, library: 'CU', codes: ['CU'] },
  ],
  record_keys: { k: ['thermal_conductivity', 'k'] },
  custom_preset: 'custom',
};

const REGISTRY = {
  ...FIXTURE_REGISTRY,
  analysis: [
    ...FIXTURE_REGISTRY.analysis,
    { key: 'heat_steady', label: 'Heat', material_models: ['newtonian_incompressible', 'fx_solid'] },
  ],
  material: [FIXTURE_MODEL, SOLID],
};

let stored: Array<Record<string, unknown>>;
const AIR = { id: 'm-air', name: 'Air', material_model: 'newtonian_incompressible', assigned_volumes: ['Body1', 'Body2'] };
const SINK = { id: 'm-al', name: 'Aluminium 6061', material_model: 'fx_solid', thermal_conductivity: 167, assigned_volumes: [] };

beforeEach(() => {
  stored = [AIR, SINK];
  useProjectStore.setState({ registry: REGISTRY as never });
  workerRpc.mockClear();
  window.__CFD_STUDY_STATE__ = { id: 's1', analysis_type: 'heat_steady' } as never;
  window.__CFD_GEOMETRY_BODIES__ = () => ['Body1', 'Body2', 'Body3'];
  window.__CFD_MATERIAL_APPLY__ = vi.fn();
  window.__CFD_MATERIAL_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_OPEN_MATERIAL__ = vi.fn();
  window.__CFD_ADD_MATERIAL__ = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/materials')) return new Response(JSON.stringify({ materials: stored }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ registry: null });
  delete window.__CFD_STUDY_STATE__;
  vi.unstubAllGlobals();
});

function lastSave(): Body {
  const call = workerRpc.mock.calls.at(-1);
  expect(call?.[0]).toBe('materials.set');
  return call?.[1]?.body || {};
}

describe('models', () => {
  it('lists every model an analysis offers, and the model and role of a record', () => {
    const rows = REGISTRY.material as MaterialModelRow[];
    expect(modelsFor('heat_steady', rows).map((m) => m.key)).toEqual(['newtonian_incompressible', 'fx_solid']);
    expect(hasSeveralMaterials('heat_steady', rows)).toBe(true);
    expect(hasSeveralMaterials('incompressible_steady', rows)).toBe(false);
    expect(modelOf({ material_model: 'fx_solid' }, 'heat_steady', rows)?.key).toBe('fx_solid');
    expect(modelOf({ material_model: 'gone' }, 'heat_steady', rows)?.key).toBe('newtonian_incompressible');
    expect([roleOf(SOLID), roleOf(FIXTURE_MODEL), roleOf(undefined)]).toEqual(['solid', 'fluid', 'fluid']);
  });

  it('takes bodies off another record, with a fresh stamp', () => {
    const left = withoutBodies({ id: 'a', assigned_volumes: ['Body1', 'Body2'], geometry_rev: 3 }, ['Body2'], 'now');
    expect(left).toMatchObject({ assigned_volumes: ['Body1'], body_ids: ['Body1'], assigned_volume: 'Body1', updated_at: 'now' });
    expect(left && 'geometry_rev' in left).toBe(false);
    expect(withoutBodies({ id: 'a', assigned_volumes: ['Body1'] }, ['Body2'], 'now')).toBeNull();
  });

  it('opens the list, a new material or one record by panel', () => {
    expect(materialsView('panel-materials-hub', undefined)).toBe('list');
    expect(materialsView('panel-air-material', '')).toBe('list');
    expect(materialsView('panel-air-material', 'm-al')).toBe('record');
    expect(materialsView('panel-material-picker', undefined)).toBe('new');
  });
});

describe('panel', () => {
  it("lists the study's materials with their role and bodies; a row opens it, Add makes a new one", async () => {
    render(<MaterialsPanel panelId="panel-materials-hub" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
    await screen.findByText('Air');
    const rows = [...document.querySelectorAll('[data-material-row]')].map((li) => li.textContent);
    expect(rows).toEqual(['AirFluid · 2 bodies', 'Aluminium 6061Solid · 0 bodies']);
    fireEvent.click(screen.getByText('Aluminium 6061'));
    expect(window.__CFD_OPEN_MATERIAL__).toHaveBeenCalledWith('m-al');
    fireEvent.click(screen.getByRole('button', { name: 'Add material' }));
    expect(window.__CFD_ADD_MATERIAL__).toHaveBeenCalled();
  });

  it('a body assigned to the solid moves off the fluid, and both records save in one call', async () => {
    render(<MaterialsPanel panelId="panel-air-material" itemId="m-al" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
    await waitFor(() => expect((screen.getByLabelText('Material type') as HTMLSelectElement).value).toBe('fx_solid'));
    expect((screen.getByLabelText('Solid') as HTMLSelectElement).value).toBe('al');
    expect(document.querySelector('[data-volume="Body2"] .mat-assign-state')?.textContent).toBe('In Air');
    // The unit system's unit of a heat-transfer quantity.
    expect(document.querySelector('[data-material-property="k"] .bc-unit-label')?.textContent).toBe('W/(m·K)');
    await act(async () => {
      publishBodySelection([{ name: 'Body2', idx: 2 }]);
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    const body = lastSave();
    expect(body.only_id).toBe('m-al');
    expect(new Set(body.only_ids)).toEqual(new Set(['m-al', 'm-air']));
    const byId = Object.fromEntries((body.materials || []).map((m) => [String(m.id), m]));
    expect(byId['m-al'].assigned_volumes).toEqual(['Body2']);
    expect(byId['m-al'].material_model).toBe('fx_solid');
    expect(byId['m-air'].assigned_volumes).toEqual(['Body1']);
  });

  it('the material picker makes a new record on its first change; Delete removes only it', async () => {
    render(<MaterialsPanel panelId="panel-material-picker" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
    const type = (await screen.findByLabelText('Material type')) as HTMLSelectElement;
    expect(type.value).toBe('newtonian_incompressible');
    // No Delete before it exists.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await act(async () => {
      fireEvent.change(type, { target: { value: 'fx_solid' } });
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    const body = lastSave();
    const made = (body.materials || []).find((m) => !['m-air', 'm-al'].includes(String(m.id)));
    expect(made).toMatchObject({ material_model: 'fx_solid', name: 'Aluminium 6061', preset: 'al', assigned_volumes: [] });
    expect(body.only_ids).toEqual([String(made?.id)]);
    stored = [AIR, SINK, made as Record<string, unknown>];
    expect((screen.getByLabelText('Solid') as HTMLSelectElement).value).toBe('al');
    const del = await screen.findByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(del);
    });
    expect(window.__CFD_MATERIAL_DELETE__).toHaveBeenCalledWith(String(made?.id));
  });

  it("an Incompressible Flow study keeps its one-fluid panel", async () => {
    window.__CFD_STUDY_STATE__ = { id: 's1', analysis_type: 'incompressible_steady' } as never;
    render(<MaterialsPanel panelId="panel-air-material" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
    await screen.findByLabelText('Fluid');
    expect(screen.queryByLabelText('Material type')).toBeNull();
    expect(document.querySelector('[data-materials-list]')).toBeNull();
  });

  it('a property with no minimum (a heat source) takes 0 and below, and stays when the preset changes', async () => {
    // API 1.8: a schema property without a minimum takes any finite number; one with a minimum stays above 0.
    const withSource: MaterialModelRow = {
      ...SOLID,
      schema: {
        properties: {
          ...(SOLID.schema?.properties || {}),
          heat_source_W: { title: 'Heat source', default: 0, 'x-cfddesk': { quantity: 'power' } },
        },
      },
    };
    useProjectStore.setState({ registry: { ...REGISTRY, material: [FIXTURE_MODEL, withSource] } as never });
    stored = [AIR, { ...SINK, heat_source_W: 10 }];
    // The route answers with what was saved (the panel reloads on cfd:material).
    workerRpc.mockImplementation(async (_method, params) => {
      stored = params?.body?.materials || stored;
      return { materials: stored };
    });
    render(<MaterialsPanel panelId="panel-air-material" itemId="m-al" projectId="p1" simId="s1" scope="p:p1/s:s1" />);
    const source = (await screen.findByLabelText('Heat source', { selector: 'input' })) as HTMLInputElement;
    await waitFor(() => expect(source.value).toBe('10'));
    expect(document.querySelector('[data-material-property="heat_source_W"] .bc-unit-label')?.textContent).toBe('W');
    for (const [typed, saved] of [['0', 0], ['-5', -5]] as const) {
      workerRpc.mockClear();
      await act(async () => {
        fireEvent.change(source, { target: { value: typed } });
        fireEvent.blur(source);
      });
      await waitFor(() => expect(workerRpc).toHaveBeenCalled());
      const rec = (lastSave().materials || []).find((m) => m.id === 'm-al');
      expect(rec?.heat_source_W).toBe(saved);
    }
    // A conductivity of 0 is not saved (its schema has a minimum).
    workerRpc.mockClear();
    const k = screen.getByLabelText('Thermal conductivity', { selector: 'input' }) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(k, { target: { value: '0' } });
      fireEvent.blur(k);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(workerRpc).not.toHaveBeenCalled();
    // Another preset: its conductivity, the source kept.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Solid'), { target: { value: 'cu' } });
    });
    await waitFor(() => expect(workerRpc).toHaveBeenCalled());
    const rec = (lastSave().materials || []).find((m) => m.id === 'm-al');
    expect(rec).toMatchObject({ preset: 'cu', thermal_conductivity: 398, heat_source_W: -5 });
    expect((screen.getByLabelText('Heat source', { selector: 'input' }) as HTMLInputElement).value).toBe('-5');
    workerRpc.mockImplementation(async (_method, params) => ({ materials: params?.body?.materials }));
  });
});
