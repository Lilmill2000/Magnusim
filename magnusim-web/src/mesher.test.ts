import { describe, expect, it } from 'vitest';
import { mesherFor, refinementMenu, reportBits, stageText, type MesherRow } from './mesher';

const standard: MesherRow = {
  key: 'standard',
  label: 'Standard',
  stage_labels: { gmsh: 'Preparing the geometry', gmshToFoam: 'Building the OpenFOAM mesh and boundary layers' },
  stage_details: [
    ['gmsh', '^surface \\(gap', 'Refining gaps'],
    ['gmsh', '^surface', 'Meshing the surface'],
    ['gmsh', '^tets:', 'Filling the volume with tetrahedra'],
  ],
  report: [
    ['', 'Standard', ''],
    ['hex_core_applied', 'hex element core', ''],
    ['layers_applied', 'boundary layers', 'no boundary layers'],
    ['surface_size_m', 'surface size {length}', ''],
  ],
  refinement_types: [{ key: 'inflate_boundary_layer', label: 'Inflate boundary layer', hint: 'Prism layers' }],
};
const rows: MesherRow[] = [standard, { key: 'cfmesh', label: 'cfMesh' }, { key: 'snappy_hexdominant' }];

describe('what the page shows for a mesher comes from its registry row', () => {
  it('finds the row by mesher key, else by the run path a core engine reports', () => {
    expect(mesherFor(rows, 'standard')?.key).toBe('standard');
    expect(mesherFor(rows, '', 'cartesianMesh')?.key).toBe('cfmesh');
    expect(mesherFor(rows, null, 'snappyHexMesh')?.key).toBe('snappy_hexdominant');
    expect(mesherFor(rows, 'example_extra_mesher')).toBeUndefined();
  });

  it("names a running stage by the mesher's detail line, then its label, else Working", () => {
    expect(stageText(standard, 'starting', '')).toBe('Starting');
    expect(stageText(standard, 'gmsh', 'surface (gap 2)')).toBe('Refining gaps');
    expect(stageText(standard, 'gmsh', 'tets: filling the volume')).toBe('Filling the volume with tetrahedra');
    expect(stageText(standard, 'gmsh', 'something new')).toBe('Preparing the geometry');
    expect(stageText(standard, 'gmshToFoam', '')).toBe('Building the OpenFOAM mesh and boundary layers');
    expect(stageText(standard, 'snappyHexMesh', '')).toBe('Working');
    expect(stageText(undefined, 'gmsh', '')).toBe('Working');
  });

  it("writes the finished mesh's summary from the mesher's report", () => {
    const fmt = (m: unknown) => (typeof m === 'number' ? `${m * 1000} mm` : null);
    expect(reportBits(standard, { hex_core_applied: true, layers_applied: false, surface_size_m: 0.002 }, fmt)).toEqual([
      'Standard',
      'hex element core',
      'no boundary layers',
      'surface size 2 mm',
    ]);
    // Unknown values say nothing rather than guess.
    expect(reportBits(standard, { hex_core_applied: null, layers_applied: null }, fmt)).toEqual(['Standard']);
    expect(reportBits(undefined, { hex_core_applied: true }, fmt)).toEqual([]);
  });

  it("offers the mesher's refinement types, and the core two before the registry loads", () => {
    expect(refinementMenu(standard).map((t) => t.label)).toEqual(['Inflate boundary layer']);
    expect(refinementMenu(undefined).map((t) => t.label)).toEqual(['Surface custom sizing', 'Inflate boundary layer']);
  });
});
