import { describe, expect, it } from 'vitest';
import { visibleAnalyses } from '../panels/simulation/SimulationPanel';
import { materialPresetLabel } from '../panels/materials/MaterialsPanel';
import { meshEngines } from '../panels/mesh/MeshPanel';
import { simulationSaveBody } from '../panels/simulation/SimulationPanel';
import type { RegistryRow } from './registry.gen';

const rows: RegistryRow[] = [
  { key: 'incompressible_steady', label: 'Incompressible Fluid Flow' },
  { key: 'example_passthrough', label: 'Example plugin (passthrough)' },
  { key: 'h3probe', label: 'H3 probe analysis' },
];

describe('gate:h3-picker-open', () => {
  it('lists a plugin analysis and drops it when the registry does', () => {
    expect(visibleAnalyses(rows).map((row) => row.key)).toEqual([
      'incompressible_steady',
      'example_passthrough',
      'h3probe',
    ]);
    expect(visibleAnalyses(rows.filter((row) => row.key !== 'h3probe')).map((row) => row.key)).not.toContain(
      'h3probe',
    );
  });

  it('keeps Air visible and leaves Water out of the material picker', () => {
    expect(materialPresetLabel({ key: 'newtonian_incompressible', label: 'Newtonian' })).toBe('Air');
    expect(materialPresetLabel({ key: 'water', label: 'Water' })).toBe('Water');
  });

  it('includes cfmesh in the mesher list', () => {
    expect(meshEngines([{ key: 'standard' }, { key: 'cfmesh' }, { key: 'snappy_hexdominant' }]).map((r) => r.key)).toContain(
      'cfmesh',
    );
  });
});

describe('gate:h3-simulation-scoped', () => {
  it('saves study A without study B id', () => {
    const body = simulationSaveBody(
      {
        panelId: 'panel-incompressible-defaults',
        projectId: 'proj',
        simId: 'study-a',
        scope: 'p:proj/g:geom/s:study-a',
      },
      { turbulence_model: 'kOmegaSST', simulation_id: 'study-b' },
    );
    expect(body.simulation_id).toBe('study-a');
    expect(body.project_id).toBe('proj');
    expect(JSON.stringify(body)).not.toContain('study-b');
  });
});
