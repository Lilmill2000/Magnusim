/**
 * GET /api/project/hydrate — one hydrate worker call and one tree worker call.
 * Disk reads stay in the worker.
 */

function withActiveSimulation(raw, projectId) {
  if (!raw || typeof raw !== 'object') return raw;
  const simulations = Array.isArray(raw.simulations) ? raw.simulations : [];
  const active =
    raw.simulation ||
    simulations.find((row) => row && String(row.id) === String(raw.active_id || '')) ||
    simulations[0] ||
    null;
  return {
    ...raw,
    ok: raw.ok !== false,
    simulation: active,
    simulations,
    active_id: (active && active.id) || raw.active_id || null,
    project_id: raw.project_id || projectId,
  };
}

function withAir(raw) {
  if (!raw || typeof raw !== 'object' || raw.air) return raw;
  const list = raw.materials_all || raw.materials;
  const air = Array.isArray(list) ? list.find((row) => row && row.name) : null;
  if (!air) return raw;
  return { ...raw, air, materials_all: raw.materials_all || list };
}

function sendDefault(res, status, body) {
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  res.end(JSON.stringify(body));
}

export async function handleProjectHydrate(req, res, url, opts = {}) {
  const send = (opts && opts.sendJson) || sendDefault;
  const id = String((url && url.searchParams && url.searchParams.get('project_id')) || '').trim();
  if (!id) {
    send(res, 400, { ok: false, error: 'project_id required' });
    return;
  }
  const workerCall = opts && opts.workerCall;
  if (typeof workerCall !== 'function') {
    send(res, 503, { ok: false, error: 'worker offline' });
    return;
  }
  const simulation_id = String(url.searchParams.get('simulation_id') || '');
  try {
    const hydrated = await workerCall('project.hydrate', { project_id: id, id, simulation_id });
    const tree = await workerCall('project.tree', { project_id: id, id });
    const body = hydrated && typeof hydrated === 'object' ? { ...hydrated } : {};
    body.simulation = withActiveSimulation(body.simulation, id);
    body.materials = withAir(body.materials);
    body.tree = (tree && (tree.tree || tree)) || null;
    send(res, 200, body);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const status = /not found/i.test(msg) ? 404 : /required/i.test(msg) ? 400 : 500;
    send(res, status, { ok: false, error: msg });
  }
}
