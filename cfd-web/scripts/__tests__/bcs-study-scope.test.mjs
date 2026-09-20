import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'cfd-bcs-scope-'));
process.env.MAGNUSIM_PROJECTS_ROOT = root;

const { createGeometryFolder, createStudyFolder, writeJsonAtomic } = await import('../project-layout.js');
const { getBcs } = await import('../w19-boundary-conditions.js');
const { studyScopedGeometryId } = await import('../w16-geometry-scope.js');

describe('BC reads stay on the study geometry', () => {
  const projectId = 'p1';

  before(() => {
    const proj = join(root, projectId);
    mkdirSync(proj, { recursive: true });
    writeFileSync(
      join(proj, 'project.json'),
      JSON.stringify({
        id: projectId,
        active_geometry_id: 'geom-first',
        geometries: [
          { id: 'geom-first', name: 'First' },
          { id: 'geom-tear', name: 'Teardrop' },
        ],
      }),
      'utf8'
    );
    writeJsonAtomic(join(proj, 'simulations.json'), {
      active_id: 'sim-tear',
      simulations: [
        { id: 'sim-first', name: 'A', geometry_id: 'geom-first' },
        { id: 'sim-tear', name: 'B', geometry_id: 'geom-tear' },
      ],
    });
    createGeometryFolder(proj, { id: 'geom-first', name: 'First', original_filename: 'First.step' });
    createGeometryFolder(proj, { id: 'geom-tear', name: 'Teardrop', original_filename: 'Teardrop.step' });
    createStudyFolder(proj, 'geom-first', { id: 'sim-first', name: 'A' });
    const tear = createStudyFolder(proj, 'geom-tear', { id: 'sim-tear', name: 'B' });
    writeJsonAtomic(join(tear.dir, 'boundary_conditions.json'), {
      simulation_id: 'sim-tear',
      geometry_id: 'geom-tear',
      boundary_conditions: [
        {
          id: 'bc-copy-1',
          name: 'Pressure 1',
          bc_type: 'Pressure',
          faces: ['face 6@Body1'],
          simulation_id: 'sim-tear',
          geometry_id: 'geom-tear',
        },
      ],
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('studyScopedGeometryId ignores the other CAD', () => {
    assert.equal(
      studyScopedGeometryId({ active_geometry_id: 'geom-first' }, { geometry_id: 'geom-tear' }, 'geom-first'),
      'geom-tear'
    );
  });

  it('returns the teardrop BCs even if hydrate asks for the first geometry', () => {
    const result = getBcs(projectId, 'geom-first', 'sim-tear');
    assert.equal(result.ok, true);
    assert.equal(result.body.boundary_conditions.length, 1);
    assert.equal(result.body.boundary_conditions[0].id, 'bc-copy-1');
    assert.equal(result.body.boundary_conditions[0].name, 'Pressure 1');
  });
});
