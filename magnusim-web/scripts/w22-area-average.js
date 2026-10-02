import { safeProjectPath } from './safe-path.js';
import { projectIdOrActive } from './request-scope.js';
/**
 * Result controls of a study: a read-only GET of /api/result-controls (and /api/area-average).
 *
 * Monitors are saved on the run (run settings), so nothing writes through here any more.
 * The read stays for the page's boot hydrate and for studies saved before monitors moved
 * to the run: the study's result_controls rows, plus an older lone area_average_1 record.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesStudy } from './w16-geometry-scope.js';
import { getActiveSimulation } from './w17-sim-catalog.js';
import { readStudyJson, studyFilePath } from './study-io.js';
import { envGet } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const _projectsRoot = envGet('PROJECTS_ROOT');
const PROJECTS_ROOT = _projectsRoot ? resolve(_projectsRoot) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

const AREA_AVERAGE_NAME = 'Area average 1';

export const POST_REFUSED = 'Monitors are saved on the run';

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return j.project_id || null;
  } catch {
    return null;
  }
}

function readProject(id) {
  const p = join(safeProjectPath(PROJECTS_ROOT, id), 'project.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function getResultControls(projectIdOpt, simIdOpt) {
  const projectId = projectIdOpt || projectIdOrActive('', readActiveId);
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: { ok: true, active: false, result_controls: [], area_average_1: null, note: 'No active project.' },
    };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return {
      ok: false,
      status: 404,
      body: { error: 'project not found', project_id: projectId },
    };
  }
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const simId = sim && sim.id;
  const doc = simId ? readStudyJson(projectId, simId, 'result_controls') : null;
  // A record in the study's own files with no study stamp is that study's; one
  // stamped with another study is not.
  const mine = (r) => !!r && matchesStudy(r, simId, simId);
  const rows = ((doc && doc.result_controls) || []).filter(mine);
  // With no rows, area_average_1 is an older lone record in result_controls.json.
  const lone = !rows.length && doc && mine(doc.area_average_1) ? doc.area_average_1 : null;
  const list = rows.length ? rows : lone ? [lone] : [];
  const aa = list.find((r) => r.name === AREA_AVERAGE_NAME) || lone;
  const filePath = simId ? studyFilePath(projectId, simId, 'result_controls') : null;

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      simulation_id: simId || null,
      result_controls: list,
      area_average_1: aa,
      result_controls_json_path: filePath,
      area_average_json_path: filePath,
    },
  };
}

export async function handleResultControlsApi(req, res, u, parts, helpers) {
  const { sendJson } = helpers;

  const isRc =
    parts[0] === 'api' &&
    (parts[1] === 'result-controls' ||
      parts[1] === 'result_controls' ||
      parts[1] === 'area-average' ||
      parts[1] === 'area_average');

  if (!isRc) return false;

  if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
    const pid = u.searchParams.get('project_id') || undefined;
    const result = getResultControls(pid, u.searchParams.get('simulation_id') || undefined);
    res.setHeader('X-CFD-Source', 'result-controls-get');
    return sendJson(res, result.status, result.body);
  }

  res.setHeader('Allow', 'GET, HEAD');
  if (req.method === 'POST') {
    return sendJson(res, 405, { ok: false, error: POST_REFUSED });
  }
  return sendJson(res, 405, {
    error: 'method not allowed for /api/result-controls|/api/area-average',
  });
}
