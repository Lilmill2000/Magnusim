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
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeometryFolder, createStudyFolder, createMeshFolder, writeJsonAtomic } from '../scripts/project-layout.js';
import { persistOneBcAt, persistOneMaterialAt } from '../scripts/study-io.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const FIXTURE_ID = 'sample-project-steady-state-e2e';
const FIXTURE_SRC = join(__dirname, 'fixtures', 'sample-project-steady-state');

/**
 * Own elbow projects for the compute-queue e2e: it meshes A (fine) and queues B behind it.
 * Not the shared sample: re-meshing that one changes the mesh every later spec reads.
 */
export const QUEUE_PROJECT_A = 'queue-project-a-e2e';
export const QUEUE_PROJECT_B = 'queue-project-b-e2e';
/** Own elbow project for mesh-unowned-generate.spec.js: it fakes a mesh another process generates. */
export const UNOWNED_MESH_PROJECT = 'unowned-mesh-e2e';

/** Copy the elbow fixture into destRoot/<id> laid out the way the app stores it. */
function seedElbowProject(destRoot, id, title) {
  const dest = join(destRoot, id);
  cpSync(FIXTURE_SRC, dest, { recursive: true });
  if (id !== FIXTURE_ID) {
    for (const name of ['project.json', 'mesh.json']) {
      const raw = JSON.parse(readFileSync(join(dest, name), 'utf8'));
      if (name === 'project.json') {
        raw.id = id;
        raw.title = title;
      } else {
        raw.project_id = id;
      }
      writeJsonAtomic(join(dest, name), raw);
    }
  }

  const doc = JSON.parse(readFileSync(join(dest, 'project.json'), 'utf8'));
  const sim = JSON.parse(readFileSync(join(dest, 'simulations.json'), 'utf8')).simulations[0];
  const geometry = createGeometryFolder(dest, { ...doc.geometries[0], original_filename: 'elbow.step' });
  const study = createStudyFolder(dest, geometry.id, sim);
  const meshDoc = JSON.parse(readFileSync(join(dest, 'mesh.json'), 'utf8'));
  const mesh = createMeshFolder(dest, sim.id, meshDoc.meshes[0]);
  writeJsonAtomic(join(mesh.dir, 'mesh.json'), meshDoc.meshes[0]);
  // The app stores each material and BC as its own child item with an id, and
  // the server reads those (not the aggregate json). Seed the study the same way.
  const slug = (v) => String(v || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const mats = JSON.parse(readFileSync(join(dest, 'materials.json'), 'utf8'));
  mats.materials = (mats.materials || []).map((m, i) => ({ id: `mat-${slug(m.name)}-${i}`, ...m, simulation_id: sim.id }));
  const bcs = JSON.parse(readFileSync(join(dest, 'boundary_conditions.json'), 'utf8'));
  bcs.boundary_conditions = (bcs.boundary_conditions || []).map((b, i) => ({ id: `bc-${slug(b.name)}-${i}`, ...b, simulation_id: sim.id }));
  writeJsonAtomic(join(study.dir, 'materials.json'), mats);
  writeJsonAtomic(join(study.dir, 'boundary_conditions.json'), bcs);
  for (const m of mats.materials) persistOneMaterialAt(dest, sim.id, m);
  for (const b of bcs.boundary_conditions) persistOneBcAt(dest, sim.id, b);
  const elbow = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'elbow.step');
  cpSync(elbow, join(geometry.dir, 'source.step'));
  for (const g of [doc.geometry, ...doc.geometries]) {
    g.step_path = join(geometry.dir, 'source.step');
  }
  writeJsonAtomic(join(dest, 'project.json'), doc);
}

export function prepareE2eProjectsRoot(destRoot = resolve(__dirname, '.tmp-projects')) {
  rmSync(destRoot, { recursive: true, force: true });
  // The server keeps this root's compute queue beside it (computeQueueFileFor in
  // scripts/server/compute-queue.ts). The projects are seeded fresh, so their queue
  // starts empty too: rows left by an interrupted run would queue ahead of the tests'.
  const tag = createHash('sha1').update(resolve(destRoot).toLowerCase()).digest('hex').slice(0, 10);
  rmSync(join(WEB_ROOT, '.cache', `compute-queue-${tag}.json`), { force: true });
  mkdirSync(destRoot, { recursive: true });
  seedElbowProject(destRoot, FIXTURE_ID);
  seedElbowProject(destRoot, QUEUE_PROJECT_A, 'Queue project A');
  seedElbowProject(destRoot, QUEUE_PROJECT_B, 'Queue project B');
  seedElbowProject(destRoot, UNOWNED_MESH_PROJECT, 'Unowned mesh');

  const emptyId = 'sample-project-empty-e2e';
  const emptyDir = join(destRoot, emptyId);
  mkdirSync(emptyDir, { recursive: true });
  writeJsonAtomic(join(emptyDir, 'project.json'), {
    id: emptyId,
    title: 'Empty project',
    description: 'Second Playwright project for the H0 leak check',
    category: 'Other',
    units: 'Metric',
    folder: 'My Projects',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    geometry: { id: 'geom-empty', name: 'Box', bodies: [] },
    geometries: [{ id: 'geom-empty', name: 'Box', original_filename: 'box.step' }],
    active_geometry_id: 'geom-empty',
    increment: 'W16',
  });
  writeJsonAtomic(join(emptyDir, 'simulations.json'), {
    active_id: 'sim-empty',
    simulations: [
      {
        id: 'sim-empty',
        name: 'Empty study',
        analysis: 'Incompressible',
        time_dependency: 'Steady-state',
        geometry_id: 'geom-empty',
        geometry_name: 'Box',
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  createGeometryFolder(emptyDir, { id: 'geom-empty', name: 'Box', original_filename: 'box.step' });
  createStudyFolder(emptyDir, 'geom-empty', { id: 'sim-empty', name: 'Empty study' });

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
