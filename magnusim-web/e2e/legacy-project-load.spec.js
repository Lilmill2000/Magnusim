import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  LEGACY_DOC_PROJECT,
  LEGACY_DOC_RUN,
  LEGACY_ORPHAN_MESH,
  LEGACY_ORPHAN_PROJECT,
  LEGACY_ORPHAN_RUN,
  seedLegacyDocProject,
} from './prepare-projects.js';

// Opening a project adopts a run folder its run list does not have (results/mesh-<id>/run-<id>,
// left by an interrupted session). The adopted run used to be named after the turbulence
// model of the core's old project model: "laminar 1" in every project made in the web app
// (that model's default), "kOmegaSST 1" in an old desktop project, whatever the run solved.
// It is "Run 1" now. An old desktop project.json still loads, and its solver and boundary
// blocks are written back exactly as they were when that adoption saves the file.
const PROJECTS = process.env.MAGNUSIM_PROJECTS_ROOT || resolve('e2e/.tmp-projects');
const hydrate = async (request, pid) => {
  const res = await request.get(`/api/project/hydrate?${new URLSearchParams({ project_id: pid })}`);
  const body = await res.json();
  expect(res.status(), JSON.stringify(body).slice(0, 500)).toBe(200);
  return body;
};

test('a run folder the run list lacks is adopted as "Run 1", not named after a turbulence model', async ({ request }) => {
  const body = await hydrate(request, LEGACY_ORPHAN_PROJECT);
  expect(body.ok).toBe(true);
  const mesh = body.mesh || {};
  const meshId = mesh.active_id || ((mesh.meshes || [])[0] || {}).id;
  expect(meshId, 'the seeded orphan sits under the study mesh').toBe(LEGACY_ORPHAN_MESH);
  const rows = (body.runs && body.runs.runs) || [];
  const run = rows.find((r) => String(r.id) === LEGACY_ORPHAN_RUN);
  expect(run, JSON.stringify(rows)).toBeTruthy();
  expect(run.name).toBe('Run 1');
  expect(rows.map((r) => r.name)).not.toContain('laminar 1');

  // Opening it again keeps the one adopted run and its name.
  const again = await hydrate(request, LEGACY_ORPHAN_PROJECT);
  const same = ((again.runs && again.runs.runs) || []).filter((r) => String(r.id) === LEGACY_ORPHAN_RUN);
  expect(same.map((r) => r.name)).toEqual(['Run 1']);
});

test('an old desktop project.json loads, and keeps its solver and boundary blocks when hydrate saves it', async ({ request }) => {
  const dir = join(PROJECTS, LEGACY_DOC_PROJECT);
  // Seeded here and removed after: the file has no web id or title, so Home has no card for it.
  const source = seedLegacyDocProject(PROJECTS);
  try {
    const body = await hydrate(request, LEGACY_DOC_PROJECT);
    expect(body.ok).toBe(true);

    // The adopted run made hydrate save project.json (the old file is kept beside it).
    const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(existsSync(join(dir, `project.json.v${source.version}.bak`))).toBe(true);
    expect(saved.version).toBe(15);
    const [was] = source.simulations;
    const [now] = saved.simulations;
    for (const key of ['solver', 'boundary', 'numerics', 'initial_conditions']) {
      expect(JSON.stringify(now[key]), key).toBe(JSON.stringify(was[key]));
    }
    const run = now.runs.find((r) => r.id === LEGACY_DOC_RUN);
    expect(run, JSON.stringify(now.runs)).toBeTruthy();
    // Its stored solver.turbulence is kOmegaSST: the run used to be "kOmegaSST 1".
    expect(was.solver.turbulence).toBe('kOmegaSST');
    expect(run.name).toBe('Run 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
