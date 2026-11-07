import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyState } from '../../../src/panels/legacyBridge';
import { SimulationDefaults } from '../../../src/panels/simulation/SimulationPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import {
  STANDARD_MESH_NOTE,
  heatSourceOf,
  shownNumericsSchema,
  shownSettingsSchema,
  solverLine,
} from './StudySettings';
import { placedMaterials } from './materials';

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
    residual_target: { type: 'number', title: 'Residual target', default: 1e-5 },
  },
};

const AIR = { id: 'm-air', name: 'Air', material_model: 'thermo_fluid', assigned_volumes: ['Body1'] };
const AL = { id: 'm-al', name: 'Aluminium 6061', material_model: 'thermo_solid', assigned_volumes: ['Body2'] };

/**
 * The materials route answers with these records (the panel reads them as the Materials
 * panel does); the mesh route with a mesh of `engine` ('' for no mesh yet).
 */
function materials(rows: unknown[], engine = 'snappy_hexdominant') {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/materials')) return new Response(JSON.stringify({ materials: rows }), { status: 200 });
    if (String(input).includes('/api/mesh')) {
      return new Response(JSON.stringify({ mesh: engine ? { id: 'mesh_1', ui_mesh_engine: engine } : null }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function study(overrides: Partial<StudyState> = {}, record: Record<string, unknown> = {}): StudyState {
  return {
    has_study: true,
    id: 'sim_1',
    name: 'Heat transfer 1',
    analysis: 'Heat transfer',
    analysis_type: 'heat_transfer_steady',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    project_id: 'proj',
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
          default_mesher: 'snappy_hexdominant',
        },
        {
          key: 'heat_transfer_transient',
          label: 'Heat Transfer (Transient)',
          time_dependency: 'transient',
          family: { key: 'heat_transfer' },
          schema: settingsSchema,
          numerics_schema: numericsSchema,
          ui: { study_settings: 'heat_transfer.study', run_settings: 'heat_transfer.run' },
          default_mesher: 'snappy_hexdominant',
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
  vi.unstubAllGlobals();
  delete window.__CFD_PROJECT_UNITS__;
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

describe('Heat Transfer study settings with a solid body (conjugate heat transfer)', () => {
  it('says the solver runs CHT and why, and hides the residual target', async () => {
    materials([AIR, AL]);
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText('Conjugate heat transfer with chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). Body1 is Air (fluid).')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Residual target')).toBeNull();
    expect(screen.getByText(/does not stop on its residuals/)).toBeInTheDocument();
    expect(screen.getByText('Heat source: Aluminium 6061 (Body2)')).toBeInTheDocument();
  });

  it("shows each solid's heat source from its material, and where to set it", async () => {
    materials([AIR, { ...AL, heat_source_W: 10, heat_source_W_m3: 0 }, { id: 'm-cu', name: 'Copper', material_model: 'thermo_solid', assigned_volumes: ['Body3'] }]);
    renderPanel();
    await waitFor(() => expect(screen.getAllByText(/^Heat source: /)).toHaveLength(2));
    const al = document.querySelector('[data-ht-heat-source="m-al"] [data-ht-heat-source-value]')!;
    expect(al.textContent).toBe('10 W');
    expect(document.querySelector('[data-ht-heat-source="m-cu"] [data-ht-heat-source-value]')!.textContent).toBe('None');
    expect(screen.getByText(/A solid's heat source is set in its material/)).toBeInTheDocument();
    // Nothing is written to the study.
    expect(window.__CFD_STUDY_UPDATE__).not.toHaveBeenCalled();
  });

  it('shows a heat source in BTU/h in an imperial project; per volume; both (to fix); an older study row', async () => {
    window.__CFD_PROJECT_UNITS__ = () => 'Imperial';
    materials([AIR, { ...AL, heat_source_W: 10 }]);
    renderPanel();
    await waitFor(() =>
      expect(document.querySelector('[data-ht-heat-source="m-al"] [data-ht-heat-source-value]')?.textContent).toBe('34.12 BTU/h'),
    );
    cleanup();
    delete window.__CFD_PROJECT_UNITS__;
    materials([AIR, { ...AL, heat_source_W: 0, heat_source_W_m3: 2.5e5 }]);
    renderPanel();
    await waitFor(() =>
      expect(document.querySelector('[data-ht-heat-source="m-al"] [data-ht-heat-source-value]')?.textContent).toBe('250000 W/m³'),
    );
    cleanup();
    materials([AIR, { ...AL, heat_source_W: 3, heat_source_W_m3: 100 }]);
    renderPanel();
    await waitFor(() =>
      expect(document.querySelector('[data-ht-heat-source="m-al"] [data-ht-heat-source-value]')?.textContent).toBe(
        '3 W and 100 W/m³ (set one of them to 0)',
      ),
    );
    cleanup();
    // A study saved before the source moved onto the material: its row still shows.
    materials([AIR, AL]);
    window.__CFD_STUDY_STATE__ = study({}, { heat_sources: JSON.stringify({ 'm-al': { mode: 'power', power_W: 7, power_density_W_m3: 0 } }) });
    renderPanel();
    await waitFor(() =>
      expect(document.querySelector('[data-ht-heat-source="m-al"] [data-ht-heat-source-value]')?.textContent).toBe('7 W'),
    );
  });

  it('says that a Standard mesh reads wall heat high next to a laminar flow and through solids, and not for a Hex-dominant one', async () => {
    materials([AIR, AL], 'standard');
    renderPanel();
    expect(await screen.findByText(STANDARD_MESH_NOTE)).toBeInTheDocument();
    expect(STANDARD_MESH_NOTE).toContain('less accurate next to a laminar flow: up to about 14 % high');
    expect(STANDARD_MESH_NOTE).toContain("about 6 % high through a solid's walls");
    // The turbulent pipe with k-omega SST's walls (Spalding's law since 2026-11-06) reads +0.3 %, not 20 % low.
    expect(STANDARD_MESH_NOTE).toContain('Its turbulent pipe (k-omega SST, wall functions) read within about 1 %');
    expect(STANDARD_MESH_NOTE).not.toContain('20 % low');
    cleanup();
    materials([AIR, AL], '');
    renderPanel();
    // No mesh yet: a new one starts on Hex-dominant (the analysis's default_mesher), so no note.
    await screen.findByText(/Conjugate heat transfer/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(STANDARD_MESH_NOTE)).toBeNull();
    cleanup();
    materials([AIR, AL], 'snappy_hexdominant');
    renderPanel();
    await screen.findByText(/Conjugate heat transfer/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(STANDARD_MESH_NOTE)).toBeNull();
    cleanup();
    // Buoyant flow (no solid) on Standard: the same note.
    materials([AIR], 'standard');
    renderPanel();
    await screen.findByText(/Solves buoyant flow/);
    expect(await screen.findByText(STANDARD_MESH_NOTE)).toBeInTheDocument();
    cleanup();
    materials([AIR], 'snappy_hexdominant');
    renderPanel();
    await screen.findByText(/Solves buoyant flow/);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(STANDARD_MESH_NOTE)).toBeNull();
  });

  it('goes back to buoyant flow when the solid becomes fluid', async () => {
    const f = materials([AIR, { ...AL, heat_source_W: 10 }]);
    renderPanel();
    await screen.findByText(/Conjugate heat transfer/);
    f.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes('/api/mesh')
        ? new Response(JSON.stringify({ mesh: null }), { status: 200 })
        : new Response(JSON.stringify({ materials: [AIR, { ...AL, material_model: 'thermo_fluid' }] }), { status: 200 }),
    );
    act(() => {
      window.dispatchEvent(new CustomEvent('cfd:material'));
    });
    await screen.findByText(/Solves buoyant flow of one fluid with buoyantSimpleFoam/);
    expect(screen.queryByText(/Heat source:/)).toBeNull();
    expect(window.__CFD_STUDY_UPDATE__).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('solverLine follows the materials', () => {
    const rows = placedMaterials([AIR, AL, { id: 'x', name: 'Copper', material_model: 'thermo_solid', assigned_volumes: ['Body3', 'Body4'] }]);
    expect(solverLine(true, rows)).toBe(
      'Conjugate heat transfer with chtMultiRegionFoam: Body2 is Aluminium 6061 and Body3 and Body4 are Copper (solid). Body1 is Air (fluid).',
    );
    expect(solverLine(false, placedMaterials([AL]))).toBe(
      'Conjugate heat transfer with chtMultiRegionSimpleFoam: Body2 is Aluminium 6061 (solid). No body is fluid: heat conduction through the solids only.',
    );
    expect(solverLine(false, placedMaterials([AIR]))).toContain('every body is fluid. Body1 is Air.');
    expect(Object.keys(shownNumericsSchema(numericsSchema as never, true).properties || {})).toEqual(['numerics_preset']);
    expect(Object.keys(shownNumericsSchema(numericsSchema as never, false).properties || {})).toContain('residual_target');
    expect(heatSourceOf({ heat_sources: { a: { mode: 'density', power_density_W_m3: '5' } } }, 'a')).toEqual({
      mode: 'density',
      power_W: 0,
      power_density_W_m3: 5,
    });
    expect(heatSourceOf({}, 'a').mode).toBe('none');
  });

  it('solverLine and shownSettingsSchema', () => {
    expect(solverLine(false)).toContain('buoyantSimpleFoam');
    expect(solverLine(true)).toContain('buoyantPimpleFoam');
    const off = shownSettingsSchema(settingsSchema as never, { gravity: 'off' });
    expect(Object.keys(off.properties || {})).not.toContain('gravity_magnitude');
    expect(Object.keys(shownSettingsSchema(settingsSchema as never, {}).properties || {})).toContain('gravity_magnitude');
  });
});

// RH3 (spec 5.5): Heat Transfer's preset note (its schemes include the energy equation's).
describe('RH3: the velocity limit (Daniel, 2026-11-05: Off is cautioned only where it is a choice)', () => {
  it("shows Off, Heat Transfer's own default, with no caution, from the registry the app generates", async () => {
    const generated = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'plugins', 'registry.json'), 'utf8')) as {
      analysis: Array<{ key: string; numerics_schema: Record<string, unknown> }>;
    };
    const real = generated.analysis.find((a) => a.key === 'heat_transfer_steady')!.numerics_schema;
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: reg.analysis.map((a) => ({ ...a, numerics_schema: real })) } });
    window.__CFD_STUDY_STATE__ = study({}, {});
    const view = renderPanel();
    await waitFor(() => expect(view.container.querySelector('[data-schema-key="velocity_limit"] select')).not.toBeNull());
    const select = view.container.querySelector('[data-schema-key="velocity_limit"] select') as HTMLSelectElement;
    expect(select.options[select.selectedIndex].textContent).toBe('Off');
    expect(view.container.querySelector('[data-schema-caution="velocity_limit"]')).toBeNull();
  });
});

describe('RH3: the preset note', () => {
  it('counts the schemes the study sets over its preset, and "Use the preset for all" clears them', async () => {
    const schemes = {
      type: 'object',
      properties: {
        ...numericsSchema.properties,
        energy_convection: { type: 'string', title: 'Energy convection', enum: ['first_order', 'second_order'], default: 'second_order', 'x-cfddesk': { group: 'schemes', advanced: true } },
        grad_limiter: { type: 'string', title: 'Gradient limiter', enum: ['strong', 'light', 'none'], default: null, 'x-cfddesk': { group: 'schemes', advanced: true, optional: true } },
      },
    };
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: reg.analysis.map((a) => ({ ...a, numerics_schema: schemes })) } });
    window.__CFD_STUDY_STATE__ = study({}, { energy_convection: 'first_order', grad_limiter: 'none' });
    const view = renderPanel();
    await waitFor(() => expect(view.container.querySelector('[data-study-preset-note="1"]')).not.toBeNull());
    expect(view.container.querySelector('[data-study-preset-note="1"]')!.textContent).toMatch(/^.+, 2 terms changed · Use the preset for all$/);
    fireEvent.click(screen.getByRole('button', { name: 'Use the preset for all' }));
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalledWith({ energy_convection: null, grad_limiter: null }));
  });

  it('an edit of the numerics saves only what the person changed: a default the form showed stays blank', async () => {
    const schemes = {
      type: 'object',
      properties: {
        ...numericsSchema.properties,
        energy_convection: { type: 'string', title: 'Energy convection', enum: ['first_order', 'second_order'], default: 'second_order', 'x-cfddesk': { group: 'schemes', advanced: true } },
        p_tolerance: { type: 'number', title: 'p_rgh tolerance', default: 1e-7, 'x-cfddesk': { group: 'linear_solvers', advanced: true } },
      },
    };
    const reg = useProjectStore.getState().registry as { analysis: Array<Record<string, unknown>> };
    useProjectStore.setState({ registry: { ...reg, analysis: reg.analysis.map((a) => ({ ...a, numerics_schema: schemes })) } });
    window.__CFD_STUDY_STATE__ = study({}, {});
    renderPanel();
    fireEvent.change(screen.getByLabelText('Energy convection', { selector: 'select' }), { target: { value: '0' } });
    await waitFor(() => expect(window.__CFD_STUDY_UPDATE__).toHaveBeenCalled());
    expect((window.__CFD_STUDY_UPDATE__ as ReturnType<typeof vi.fn>).mock.calls.map(([patch]) => patch)).toEqual([{ energy_convection: 'first_order' }]);
  });
});
