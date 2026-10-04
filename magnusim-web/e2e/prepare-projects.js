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
/** Own elbow project for h7-steady-transient.spec.js: it toggles the study and stops/restarts runs. */
export const H7_PROJECT = 'h7-steady-transient-e2e';
/** Own elbow project for h8-contract.spec.js: a study of the stub analysis plugin. */
export const H8_PROJECT = 'h8-contract-e2e';
/** Own elbow project for mesh-form-load.spec.js: it saves its mesh's settings and starts a Generate. */
export const MESH_FORM_PROJECT = 'mesh-form-load-e2e';
/**
 * Own elbow project for materials-presets.spec.js: its saved Air (no library code,
 * the numbers of older versions) must open unchanged, and it adds a study.
 */
export const MATERIALS_PROJECT = 'materials-presets-e2e';
/** A project with no geometry at all (h11-plugin-studies.spec.js: plugin studies in the empty stage). */
export const NO_GEOMETRY_PROJECT = 'no-geometry-e2e';
/**
 * Own elbow project for lifecycle.spec.js, saved before a study delete dropped the study
 * from simulations.json: the index still lists the deleted study, as active_id, and
 * simulation.json is a copy of it. Its folder is gone.
 */
export const MISSING_STUDY_PROJECT = 'missing-study-e2e';
export const MISSING_STUDY_ID = 'sim-deleted-e2e';
/**
 * The round and the teardrop hole plate, for lifecycle.spec.js; the teardrop has no study.
 * A study's folder is made before its row in simulations.json, and a server stopped in
 * between leaves a study the tree shows (it walks the folders) and the index does not
 * list: here the round plate's second study. Removing the teardrop deleted every study
 * folder the index did not list.
 */
export const GEOMETRY_REMOVE_PROJECT = 'geometry-remove-e2e';
export const GEOMETRY_REMOVE_IDS = Object.freeze({
  round: 'geom-round-e2e',
  tear: 'geom-tear-e2e',
  roundStudy: 'sim-round-e2e',
  unlistedStudy: 'sim-round-unlisted-e2e',
});

/**
 * legacy-project-load.spec.js: an elbow project with a run folder its run list does not
 * have (results/mesh-<mesh>/run-<id>, as an interrupted session leaves it). Opening the
 * project adopts it.
 */
export const LEGACY_ORPHAN_PROJECT = 'legacy-orphan-run-e2e';
export const LEGACY_ORPHAN_RUN = 'orphan-e2e-1';
export const LEGACY_ORPHAN_MESH = JSON.parse(readFileSync(join(FIXTURE_SRC, 'mesh.json'), 'utf8')).meshes[0].id;
/**
 * legacy-project-load.spec.js: an old desktop project.json (python/tests/fixtures/projects/v13.json,
 * with its solver and boundary blocks) and a run folder its run list does not have. The spec
 * seeds it with seedLegacyDocProject and removes it: the file has no web id or title.
 */
export const LEGACY_DOC_PROJECT = 'legacy-python-doc-e2e';
export const LEGACY_DOC_RUN = 'orphan-e2e-doc';

/** A run folder with a mesh, as a copy-back leaves it, under <projectDir>/results/mesh-<meshId>. */
function seedOrphanRun(projectDir, meshId, runId) {
  const polyMesh = join(projectDir, 'results', `mesh-${meshId}`, `run-${runId}`, 'constant', 'polyMesh');
  mkdirSync(polyMesh, { recursive: true });
  writeFileSync(join(polyMesh, 'points'), 'x\n');
}

/** Seed LEGACY_DOC_PROJECT under root; returns the project.json it wrote (parsed). */
export function seedLegacyDocProject(root) {
  const dest = join(root, LEGACY_DOC_PROJECT);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const raw = readFileSync(join(WEB_ROOT, 'python', 'tests', 'fixtures', 'projects', 'v13.json'), 'utf8');
  writeFileSync(join(dest, 'project.json'), raw);
  const doc = JSON.parse(raw);
  seedOrphanRun(dest, doc.simulations[0].active_mesh_id, LEGACY_DOC_RUN);
  return doc;
}

/** Copy the elbow fixture into destRoot/<id> laid out the way the app stores it. */
export function seedElbowProject(destRoot, id, title) {
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

function seedGeometryRemoveProject(destRoot) {
  const id = GEOMETRY_REMOVE_PROJECT;
  const ids = GEOMETRY_REMOVE_IDS;
  const dest = join(destRoot, id);
  mkdirSync(dest, { recursive: true });
  const fixtures = join(WEB_ROOT, 'python', 'tests', 'fixtures', 'geometry');
  const parts = [
    [ids.round, 'transient-test.step'],
    [ids.tear, 'transient-test-teardrop.step'],
  ].map(([gid, file]) => {
    const name = file.replace(/\.step$/, '');
    const folder = createGeometryFolder(dest, { id: gid, name, original_filename: file });
    const stepPath = join(folder.dir, 'source.step');
    cpSync(join(fixtures, file), stepPath);
    return {
      id: gid,
      name,
      original_filename: file,
      step_path: stepPath,
      source_kind: 'step',
      representation: 'step',
      n_solids: 1,
      assembly_bodies: ['Body1'],
    };
  });
  const study = (sid, gid, name) => ({
    id: sid,
    name,
    analysis: 'Incompressible',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
    turbulence_model: 'k-omega SST',
    geometry_id: gid,
  });
  const listed = study(ids.roundStudy, ids.round, 'Round baseline');
  createStudyFolder(dest, ids.round, listed);
  createStudyFolder(dest, ids.round, study(ids.unlistedStudy, ids.round, 'Round fine'));
  writeJsonAtomic(join(dest, 'simulations.json'), {
    active_id: listed.id,
    simulations: [listed],
    updated_at: '2026-01-01T00:00:00.000Z',
  });
  writeJsonAtomic(join(dest, 'simulation.json'), listed);
  const [round] = parts;
  writeJsonAtomic(join(dest, 'project.json'), {
    id,
    title: 'Geometry removed, unlisted study kept',
    description: 'Two geometries; simulations.json lists one of the two round plate studies',
    category: 'Other',
    units: 'Metric',
    folder: 'My Projects',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    geometry: {
      id: round.id,
      name: round.name,
      bodies: ['Body1'],
      volume: 'Body1',
      step_path: round.step_path,
      source_kind: 'step',
      representation: 'step',
      tessellated: false,
    },
    geometries: parts,
    active_geometry_id: round.id,
    increment: 'W16',
  });
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
  seedElbowProject(destRoot, H7_PROJECT, 'Steady and transient');
  seedElbowProject(destRoot, H8_PROJECT, 'Analysis contract');
  seedElbowProject(destRoot, MESH_FORM_PROJECT, 'Mesh form load');
  seedElbowProject(destRoot, MATERIALS_PROJECT, 'Fluid presets');
  seedElbowProject(destRoot, MISSING_STUDY_PROJECT, 'Deleted study still listed');
  const missingDir = join(destRoot, MISSING_STUDY_PROJECT);
  const index = JSON.parse(readFileSync(join(missingDir, 'simulations.json'), 'utf8'));
  const deleted = {
    ...index.simulations[0],
    id: MISSING_STUDY_ID,
    name: 'Deleted study',
    time_dependency: 'Transient',
    algorithm: 'PIMPLE',
  };
  writeJsonAtomic(join(missingDir, 'simulations.json'), {
    ...index,
    active_id: MISSING_STUDY_ID,
    simulations: [...index.simulations, deleted],
  });
  writeJsonAtomic(join(missingDir, 'simulation.json'), deleted);
  seedGeometryRemoveProject(destRoot);
  seedElbowProject(destRoot, LEGACY_ORPHAN_PROJECT, 'Orphan run folder');
  seedOrphanRun(join(destRoot, LEGACY_ORPHAN_PROJECT), LEGACY_ORPHAN_MESH, LEGACY_ORPHAN_RUN);
  mkdirSync(join(destRoot, NO_GEOMETRY_PROJECT), { recursive: true });
  writeJsonAtomic(join(destRoot, NO_GEOMETRY_PROJECT, 'project.json'), {
    id: NO_GEOMETRY_PROJECT,
    title: 'No geometry',
    description: 'A new project before any geometry is added',
    category: 'Other',
    units: 'Metric',
    folder: 'My Projects',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    geometries: [],
    increment: 'W16',
  });

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
