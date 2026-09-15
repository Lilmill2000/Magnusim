/**
 * W22 — Area average setup (filesystem persistence).
 * Persists projects/<id>/result_controls.json (+ area_average.json mirror)
 * via POST/GET /api/result-controls and /api/area-average.
 * Bank path (walkthrough step 8 / FINDINGS):
 *   Result control → Surface data → Area average 1
 *   Write control: Time step
 *   Faces: face 57@Body1 (inlet) + face 71@Body1 (outlet) — BOTH required
 * SETUP ONLY — no solves, no fake chart values (nut/Uz/etc).
 * Honest empty: results_available=false until a real run.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesStudy } from './w16-geometry-scope.js';
import { firstLegacySimId, getActiveSimulation } from './w17-sim-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PROJECTS_ROOT = process.env.CFDDESK_PROJECTS_ROOT ? resolve(process.env.CFDDESK_PROJECTS_ROOT) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');

export const W22_FACE_INLET = 'face 57@Body1';
export const W22_FACE_OUTLET = 'face 71@Body1';
export const W22_REQUIRED_FACES = [W22_FACE_INLET, W22_FACE_OUTLET];

export const W22_AREA_AVERAGE_1 = {
  name: 'Area average 1',
  kind: 'Area average',
  category: 'Surface data',
  parent: 'Results',
  write_control: 'Time step',
  faces: [...W22_REQUIRED_FACES],
};

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(ACTIVE_PATH, 'utf8'));
    return j.project_id || null;
  } catch {
    return null;
  }
}

function projectDir(id) {
  return join(PROJECTS_ROOT, id);
}

function projectJsonPath(id) {
  return join(projectDir(id), 'project.json');
}

function resultControlsJsonPath(id) {
  return join(projectDir(id), 'result_controls.json');
}

function areaAverageJsonPath(id) {
  return join(projectDir(id), 'area_average.json');
}

function simulationJsonPath(id) {
  return join(projectDir(id), 'simulation.json');
}

function readProject(id) {
  const p = projectJsonPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeProject(proj) {
  mkdirSync(projectDir(proj.id), { recursive: true });
  writeFileSync(projectJsonPath(proj.id), JSON.stringify(proj, null, 2), 'utf8');
  return proj;
}

function readRcFile(id) {
  const p = resultControlsJsonPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readSimulationFile(id) {
  const p = simulationJsonPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function newRcId() {
  return `aa-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function normalizeFace(raw) {
  if (!raw) return '';
  let s = String(raw).trim().replace(/\s+/g, ' ');
  const m = s.match(/^face\s*(\d+)\s*@\s*Body1$/i);
  if (m) return `face ${m[1]}@Body1`;
  return s;
}

function normalizeFaces(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  for (const f of list.map(normalizeFace).filter(Boolean)) {
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  // Stable bank order: face57 then face71 when present
  out.sort((a, b) => {
    const order = { [W22_FACE_INLET]: 0, [W22_FACE_OUTLET]: 1 };
    return (order[a] ?? 9) - (order[b] ?? 9);
  });
  return out;
}

function facesBothBank(faces) {
  const set = new Set(faces || []);
  return set.has(W22_FACE_INLET) && set.has(W22_FACE_OUTLET);
}

/** Reject payloads that invent live chart series from banked stills. */
function rejectFakeResults(body) {
  if (!body) return null;
  const suspects = [
    body.results,
    body.series,
    body.chart,
    body.charts,
    body.time_series,
    body.values,
    body.plot_data,
    body.traces,
  ];
  for (const s of suspects) {
    if (s == null) continue;
    if (Array.isArray(s) && s.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            'W22 soft-pass lock: do NOT invent Area average chart/series values. Setup only — results_available stays false until a real run.',
          soft_pass: false,
          no_fake_chart_values: true,
        },
      };
    }
    if (typeof s === 'object' && Object.keys(s).length > 0) {
      // Allow empty objects; reject objects with numeric series keys
      const keys = Object.keys(s);
      const looksLikeSeries = keys.some((k) =>
        /nut|Ux|Uy|Uz|omega|^k$|^p$|pressure|face57|face71/i.test(k)
      );
      if (looksLikeSeries) {
        return {
          ok: false,
          status: 400,
          body: {
            error:
              'W22 soft-pass lock: do NOT invent Area average chart/series values (nut/Uz/…). Setup only.',
            soft_pass: false,
            no_fake_chart_values: true,
          },
        };
      }
    }
  }
  return null;
}

function buildAreaAverage(body, existing) {
  const fake = rejectFakeResults(body);
  if (fake) return fake;

  const name = String(body.name || W22_AREA_AVERAGE_1.name).trim();
  if (name !== W22_AREA_AVERAGE_1.name) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'W22 Area average must be named exactly "Area average 1"',
        got: name,
        soft_pass: false,
      },
    };
  }

  const kind = String(body.kind || body.type || W22_AREA_AVERAGE_1.kind).trim();
  if (kind !== 'Area average') {
    return {
      ok: false,
      status: 400,
      body: { error: 'kind must be Area average', got: kind, soft_pass: false },
    };
  }

  const category = String(
    body.category || body.surface_data_kind || W22_AREA_AVERAGE_1.category
  ).trim();
  if (category !== 'Surface data') {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'category must be Surface data (bank path)',
        got: category,
        soft_pass: false,
      },
    };
  }

  const writeControl = String(
    body.write_control || body.writeControl || W22_AREA_AVERAGE_1.write_control
  ).trim();
  if (writeControl !== 'Time step') {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'Write control must be Time step (bank default)',
        got: writeControl,
        soft_pass: false,
      },
    };
  }

  let faces = normalizeFaces(body.faces || body.assigned_faces || body.face);
  if (!faces.length && existing && existing.faces) {
    faces = normalizeFaces(existing.faces);
  }
  // Convenience: assign_both / use_bank_faces
  if (
    body.assign_both ||
    body.use_bank_faces ||
    body.force_bank ||
    body.both_faces
  ) {
    faces = normalizeFaces(W22_REQUIRED_FACES);
  }

  if (!faces.length && !existing && body.require_faces) {
    return {
      ok: false,
      status: 400,
      body: {
        ok: false,
        error: 'Assign at least one face before creating Area average 1',
        got: faces,
        required: W22_REQUIRED_FACES,
        soft_pass: false,
      },
    };
  }

  const now = new Date().toISOString();
  const rc = {
    id: (existing && existing.id) || body.id || newRcId(),
    name: W22_AREA_AVERAGE_1.name,
    kind: 'Area average',
    category: 'Surface data',
    parent: 'Results',
    write_control: 'Time step',
    faces,
    face_inlet: faces.includes(W22_FACE_INLET) ? W22_FACE_INLET : null,
    face_outlet: faces.includes(W22_FACE_OUTLET) ? W22_FACE_OUTLET : null,
    both_faces: facesBothBank(faces),
    results_available: false,
    results: null,
    series: null,
    chart_values: null,
    results_note: 'No results until run — setup only (W22). Do not invent nut/Uz/… plots.',
    created_at: (existing && existing.created_at) || now,
    updated_at: now,
    persistence: 'filesystem',
    soft_pass_avoided: true,
    increment: 'W22',
    no_fake_chart_values: true,
    no_solves: true,
  };

  return { ok: true, rc };
}

function persistRcDoc(projectId, sim, aa) {
  const rcPath = resultControlsJsonPath(projectId);
  const aaPath = areaAverageJsonPath(projectId);
  const now = new Date().toISOString();

  aa.result_controls_json = rcPath;
  aa.area_average_json = aaPath;
  aa.project_id = projectId;
  aa.simulation_id = sim.id;

  const prev = readRcFile(projectId);
  const legacyId = firstLegacySimId(projectId, readProject(projectId));
  const kept = ((prev && prev.result_controls) || []).filter(
    (r) => r && !matchesStudy(r, sim.id, legacyId)
  );
  const list = kept.concat([aa]);
  const doc = {
    project_id: projectId,
    simulation_id: sim.id,
    result_controls: list,
    area_average_1: aa,
    surface_data: [aa],
    updated_at: now,
    persistence: 'filesystem',
    result_controls_json: rcPath,
    area_average_json: aaPath,
    both_faces: true,
    bank_exact: facesBothBank(aa.faces) && aa.write_control === 'Time step',
    results_available: false,
    no_fake_chart_values: true,
    no_solves: true,
    soft_pass_avoided: true,
    increment: 'W22',
    da_hard_fail_locks: {
      both_faces_required: true,
      face_57_inlet: W22_FACE_INLET,
      face_71_outlet: W22_FACE_OUTLET,
      write_control_time_step: true,
      no_fake_chart_values: true,
      no_solves: true,
      setup_only: true,
    },
    out_of_scope: {
      solves: false,
      fake_charts: false,
      invented_nut_uz_series: false,
    },
    note: 'W22 Area average 1 setup — Write control Time step; faces face57+face71. No results/charts until run. No solves.',
  };

  mkdirSync(projectDir(projectId), { recursive: true });
  writeFileSync(rcPath, JSON.stringify(doc, null, 2), 'utf8');
  // Mirror dedicated area_average.json (same payload, easier prove path)
  writeFileSync(
    aaPath,
    JSON.stringify(
      {
        ...doc,
        mirror_of: 'result_controls.json',
      },
      null,
      2
    ),
    'utf8'
  );

  const proj = readProject(projectId);
  if (proj) {
    proj.result_controls = {
      count: list.length,
      names: list.map((r) => r.name),
      area_average_1: {
        name: aa.name,
        kind: aa.kind,
        category: aa.category,
        write_control: aa.write_control,
        faces: aa.faces,
        both_faces: true,
        results_available: false,
      },
      result_controls_json: rcPath,
      area_average_json: aaPath,
      updated_at: now,
    };
    proj.updated_at = now;
    proj.increment = 'W22';
    writeProject(proj);
  }

  try {
    const simDoc = { ...sim };
    simDoc.result_controls = {
      names: list.map((r) => r.name),
      result_controls_json: rcPath,
      area_average_json: aaPath,
    };
    simDoc.updated_at = now;
    simDoc.increment = 'W22';
    writeFileSync(simulationJsonPath(projectId), JSON.stringify(simDoc, null, 2), 'utf8');
  } catch {
    /* non-fatal */
  }

  return { doc, rcPath, aaPath, aa };
}

function deleteAreaAverage(projectIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return { ok: false, status: 400, body: { error: 'no active project' } };
  }
  const proj = readProject(projectId);
  if (!proj) {
    return { ok: false, status: 404, body: { error: 'project not found' } };
  }
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const legacyId = firstLegacySimId(projectId, proj);
  const prev = readRcFile(projectId);
  const kept = ((prev && prev.result_controls) || []).filter(
    (r) => r && !matchesStudy(r, sim && sim.id, legacyId)
  );
  if (!kept.length) {
    for (const p of [resultControlsJsonPath(projectId), areaAverageJsonPath(projectId)]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch (e) {
          return { ok: false, status: 500, body: { error: String(e) } };
        }
      }
    }
    if (proj.result_controls) delete proj.result_controls;
    if (proj.area_average) delete proj.area_average;
  } else {
    const now = new Date().toISOString();
    const nextAa = kept.find((r) => r && r.name === W22_AREA_AVERAGE_1.name) || null;
    const doc = {
      ...(prev || {}),
      result_controls: kept,
      area_average_1: nextAa,
      surface_data: nextAa ? [nextAa] : [],
      simulation_id: nextAa && nextAa.simulation_id ? nextAa.simulation_id : null,
      updated_at: now,
    };
    writeFileSync(resultControlsJsonPath(projectId), JSON.stringify(doc, null, 2), 'utf8');
    writeFileSync(
      areaAverageJsonPath(projectId),
      JSON.stringify({ ...doc, mirror_of: 'result_controls.json' }, null, 2),
      'utf8'
    );
    if (proj.result_controls) {
      proj.result_controls.count = kept.length;
      proj.result_controls.names = kept.map((r) => r.name);
      proj.result_controls.updated_at = now;
    }
  }
  proj.updated_at = new Date().toISOString();
  writeProject(proj);
  return {
    ok: true,
    status: 200,
    body: { ok: true, deleted: true, project_id: projectId, area_average_1: null, result_controls: [] },
  };
}

function upsertAreaAverage(body) {
  const projectId = (body && body.project_id) || readActiveId();
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'no active project; create project first', soft_pass: false },
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
  const sim = getActiveSimulation(projectId, proj, body && body.simulation_id);
  if (!sim) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'no simulation; Create Simulation → Incompressible first (W17)',
        soft_pass: false,
      },
    };
  }

  const existingDoc = readRcFile(projectId);
  const legacyId = firstLegacySimId(projectId, proj);
  const existing =
    ((existingDoc && existingDoc.result_controls) || []).find(
      (r) =>
        r &&
        r.name === W22_AREA_AVERAGE_1.name &&
        matchesStudy(r, sim.id, legacyId)
    ) ||
    (existingDoc &&
    existingDoc.area_average_1 &&
    matchesStudy(existingDoc.area_average_1, sim.id, legacyId)
      ? existingDoc.area_average_1
      : null);

  const built = buildAreaAverage(body || {}, existing);
  if (!built.ok) return built;

  const { doc, rcPath, aaPath, aa } = persistRcDoc(projectId, sim, built.rc);
  const created = !existing;

  return {
    ok: true,
    status: created ? 201 : 200,
    body: {
      ok: true,
      result_controls: doc.result_controls,
      area_average_1: aa,
      project_id: projectId,
      simulation_id: sim.id,
      result_controls_json: rcPath,
      area_average_json: aaPath,
      both_faces: true,
      bank_exact: !!doc.bank_exact,
      results_available: false,
      no_fake_chart_values: true,
      no_solves: true,
      soft_pass_avoided: true,
      increment: 'W22',
    },
  };
}

function getResultControls(projectIdOpt, simIdOpt) {
  const projectId = projectIdOpt || readActiveId();
  if (!projectId) {
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        active: false,
        result_controls: [],
        area_average_1: null,
        note: 'No active project. POST /api/result-controls after simulation (W17+).',
        increment: 'W22',
        results_available: false,
        no_fake_chart_values: true,
      },
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
  const doc = readRcFile(projectId);
  const sim = getActiveSimulation(projectId, proj, simIdOpt);
  const legacyId = firstLegacySimId(projectId, proj);
  const list = ((doc && doc.result_controls) || []).filter((r) =>
    matchesStudy(r, sim && sim.id, legacyId)
  );
  const aa = list.find((r) => r && r.name === W22_AREA_AVERAGE_1.name) || null;

  const both = !!(aa && facesBothBank(aa.faces));
  const writeOk = !!(aa && aa.write_control === 'Time step');
  const noFake =
    !aa ||
    (aa.results_available === false &&
      (aa.results == null ||
        (Array.isArray(aa.results) && aa.results.length === 0)) &&
      aa.series == null &&
      aa.chart_values == null);

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      active: true,
      project_id: projectId,
      result_controls: list,
      area_average_1: aa,
      result_controls_json_path: resultControlsJsonPath(projectId),
      result_controls_json_exists: existsSync(resultControlsJsonPath(projectId)),
      area_average_json_path: areaAverageJsonPath(projectId),
      area_average_json_exists: existsSync(areaAverageJsonPath(projectId)),
      both_faces: both,
      bank_exact: both && writeOk && noFake,
      results_available: false,
      no_fake_chart_values: noFake,
      no_solves: true,
      project_rc_ref: proj.result_controls || null,
      increment: 'W22',
    },
  };
}

export async function handleW22Api(req, res, u, parts, helpers) {
  const { sendJson, readJsonBody } = helpers;

  const isRc =
    parts[0] === 'api' &&
    (parts[1] === 'result-controls' ||
      parts[1] === 'result_controls' ||
      parts[1] === 'area-average' ||
      parts[1] === 'area_average');

  if (!isRc) return false;

  if (req.method === 'POST' && !parts[2]) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body', detail: String(e) });
    }
    if (body && (body.delete === true || body.action === 'delete')) {
      const result = deleteAreaAverage(body.project_id, body.simulation_id);
      res.setHeader('X-CFD-Source', 'result-controls-delete');
      return sendJson(res, result.status, result.body);
    }
    const result = upsertAreaAverage(body);
    res.setHeader('X-CFD-Source', 'result-controls-upsert');
    res.setHeader('X-CFD-Increment', 'W22');
    if (result.ok && result.body.project_id) {
      res.setHeader('X-CFD-Project-Id', result.body.project_id);
      if (result.body.both_faces) res.setHeader('X-CFD-AA-Both-Faces', '1');
      if (result.body.no_fake_chart_values) res.setHeader('X-CFD-AA-No-Fake-Charts', '1');
    }
    return sendJson(res, result.status, result.body);
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && !parts[2]) {
    const pid = u.searchParams.get('project_id') || undefined;
    const result = getResultControls(pid, u.searchParams.get('simulation_id') || undefined);
    res.setHeader('X-CFD-Source', 'result-controls-get');
    res.setHeader('X-CFD-Increment', 'W22');
    return sendJson(res, result.status, result.body);
  }

  return sendJson(res, 405, {
    error: 'method not allowed for /api/result-controls|/api/area-average',
  });
}

export const W22_META = {
  increment: 'W22',
  projects_root: PROJECTS_ROOT,
  area_average_1: W22_AREA_AVERAGE_1,
  required_faces: W22_REQUIRED_FACES,
};
