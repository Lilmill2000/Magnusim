/**
 * One Node read of project + setup JSON. Open must not spawn project_cli.
 */
import { getProjectById } from './w16-project-geometry.js';
import { getSimulation } from './w17-simulation.js';
import { getMaterials } from './w18-materials.js';
import { getBcs } from './w19-boundary-conditions.js';
import { getMesh } from './w20-mesh.js';
import { getRefinements } from './w26-mesh-refinements.js';
import { getResultControls } from './w22-area-average.js';
import { getRunStatus, getSimulationControl } from './w27-solve.js';

export function handleProjectHydrate(req, res, u, { sendJson }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed for /api/project/hydrate' });
  }
  const id = String(u.searchParams.get('project_id') || '').trim();
  if (!id) return sendJson(res, 400, { error: 'project_id required' });
  const proj = getProjectById(id);
  if (!proj.ok) return sendJson(res, proj.status, proj.body);
  const persist = { persist: false };
  const wantSim = String(u.searchParams.get('simulation_id') || '').trim() || undefined;
  const sim = getSimulation(id, wantSim);
  const sid =
    wantSim ||
    (sim && sim.body && (sim.body.simulation && sim.body.simulation.id)) ||
    undefined;
  const simRec = sim && sim.body && sim.body.simulation;
  const geom =
    (simRec && simRec.geometry_id) ||
    String(u.searchParams.get('geometry_id') || '').trim() ||
    undefined;
  const mat = getMaterials(id, geom, sid);
  const bcs = getBcs(id, geom, sid);
  const mesh = getMesh(id, geom, sid, {
    ...persist,
    meshId: String(u.searchParams.get('mesh_id') || '').trim() || undefined,
  });
  const refs = getRefinements(id, sid);
  const rcs = getResultControls(id, sid);
  const runs = getRunStatus(id, undefined, sid, { ...persist, slim: true });
  const ctrl = getSimulationControl(id, sid);
  return sendJson(res, 200, {
    ok: true,
    project_id: id,
    project: proj.body && proj.body.project,
    simulation: (sim && sim.body) || null,
    materials: (mat && mat.body) || null,
    bcs: (bcs && bcs.body) || null,
    mesh: (mesh && mesh.body) || null,
    refinements: (refs && refs.body) || null,
    runs: (runs && runs.body) || null,
    result_controls: (rcs && rcs.body) || null,
    simulation_control: ctrl || null,
    increment: 'hydrate',
  });
}
