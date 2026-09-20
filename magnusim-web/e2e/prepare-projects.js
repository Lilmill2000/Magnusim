/**
 * Seed an isolated MAGNUSIM_PROJECTS_ROOT for Playwright so tests never
 * read or write the developer's live cfd-web/projects/.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeometryFolder, createStudyFolder, createMeshFolder, writeJsonAtomic } from '../scripts/project-layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const FIXTURE_ID = 'sample-project-steady-state-e2e';
const FIXTURE_SRC = join(__dirname, 'fixtures', 'sample-project-steady-state');

export function prepareE2eProjectsRoot() {
  const destRoot = resolve(__dirname, '.tmp-projects');
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(destRoot, { recursive: true });
  const dest = join(destRoot, FIXTURE_ID);
  cpSync(FIXTURE_SRC, dest, { recursive: true });

  const doc = JSON.parse(readFileSync(join(dest, 'project.json'), 'utf8'));
  const sim = JSON.parse(readFileSync(join(dest, 'simulations.json'), 'utf8')).simulations[0];
  const geometry = createGeometryFolder(dest, { ...doc.geometries[0], original_filename: 'elbow.step' });
  const study = createStudyFolder(dest, geometry.id, sim);
  const meshDoc = JSON.parse(readFileSync(join(dest, 'mesh.json'), 'utf8'));
  const mesh = createMeshFolder(dest, sim.id, meshDoc.meshes[0]);
  writeJsonAtomic(join(mesh.dir, 'mesh.json'), meshDoc.meshes[0]);
  for (const name of ['materials.json', 'boundary_conditions.json']) {
    cpSync(join(dest, name), join(study.dir, name));
  }
  const elbow = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'elbow.step');
  cpSync(elbow, join(geometry.dir, 'source.step'));
  for (const g of [doc.geometry, ...doc.geometries]) {
    g.step_path = join(geometry.dir, 'source.step');
  }
  writeJsonAtomic(join(dest, 'project.json'), doc);

  writeFileSync(
    join(destRoot, 'active.json'),
    JSON.stringify({ project_id: FIXTURE_ID, updated_at: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return destRoot;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('prepare-projects.js')) {
  const root = process.env.MAGNUSIM_E2E_PROJECTS_ROOT || prepareE2eProjectsRoot();
  const prefs = process.env.MAGNUSIM_LOCAL_JSON || resolve(__dirname, '.tmp-prefs.json');
  writeFileSync(prefs, JSON.stringify({ wizard_completed: true, units: 'Metric', port: Number(process.env.MAGNUSIM_PORT || 8083) }));
  process.stdout.write(root + '\n');
}
