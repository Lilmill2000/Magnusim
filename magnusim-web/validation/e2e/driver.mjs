// The validation set's driver: one plan.json (python -m magnusim_validation plan) sent to a
// running app over HTTP, through the routes the page and the Assistant use: project, STEP
// upload, face table, study, fluid, BCs, mesh and its refinements, Generate, run settings,
// the Start gate and the pre-run check, Start, then monitors, run health, the solver log,
// the saved times and Plot over path. Every write is read back and compared (a refused or
// partial save stops the run with the route's words); every answer is saved in raw/, and
// driver.json records the ids, the case folders, the timings and each step's outcome.
// validation/README.md.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join } from 'node:path';

/** A face of the plan matches the app's within these (mm, unit normal, relative area). */
export const FACE_TOL = { centroid_mm: 0.01, normal: 1e-6, area_rel: 1e-6 };

/** Problems between the plan's face table (geometry.faces) and the app's (`part=meta` faces). */
export function faceTableProblems(expected, got) {
  const out = [];
  const byId = new Map((got || []).map((f) => [Number(f.id), f]));
  if ((got || []).length !== expected.length) out.push(`the app has ${(got || []).length} faces, the plan ${expected.length}`);
  for (const e of expected) {
    const g = byId.get(Number(e.id));
    if (!g) {
      out.push(`face ${e.id}: not in the app's table`);
      continue;
    }
    const c = g.centroid || [];
    const dc = Math.max(...e.centroid_mm.map((v, i) => Math.abs(v - Number(c[i]))));
    if (!(dc <= FACE_TOL.centroid_mm)) out.push(`face ${e.id}: centroid ${JSON.stringify(c)} mm, the plan's ${JSON.stringify(e.centroid_mm)}`);
    if (e.normal && g.normal) {
      const dn = Math.max(...e.normal.map((v, i) => Math.abs(v - Number(g.normal[i]))));
      if (!(dn <= FACE_TOL.normal)) out.push(`face ${e.id}: normal ${JSON.stringify(g.normal)}, the plan's ${JSON.stringify(e.normal)}`);
    } else if (!!e.normal !== !!g.normal) out.push(`face ${e.id}: normal ${JSON.stringify(g.normal)}, the plan's ${JSON.stringify(e.normal)}`);
    const da = Math.abs(Number(g.area) / e.area_mm2 - 1);
    if (!(da <= FACE_TOL.area_rel)) out.push(`face ${e.id}: area ${g.area} mm², the plan's ${e.area_mm2}`);
  }
  return out;
}

const close = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
};

/**
 * What a stored record lacks of what was sent: `sent`'s keys (nested objects key by key,
 * lists as a whole) compared with `stored`; numbers within a relative 1e-9. Returns
 * ["key: sent X, stored Y", ...].
 */
export function readBackProblems(sent, stored, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(sent || {})) {
    const s = stored ? stored[k] : undefined;
    const name = `${prefix}${k}`;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...readBackProblems(v, s && typeof s === 'object' ? s : {}, `${name}.`));
    } else if (typeof v === 'number') {
      if (!close(v, s)) out.push(`${name}: sent ${JSON.stringify(v)}, stored ${JSON.stringify(s)}`);
    } else if (JSON.stringify(v) !== JSON.stringify(s)) {
      out.push(`${name}: sent ${JSON.stringify(v)}, stored ${JSON.stringify(s)}`);
    }
  }
  return out;
}

/** Plot over path's `points`: "x,y,z;x,y,z" in metres. */
export function pointsParam(points) {
  return points.map((p) => p.map((v) => String(Number(v))).join(',')).join(';');
}

/** The latest saved time of a /api/times answer (its `times` list, numbers or strings). */
export function latestTime(answer) {
  const list = (answer && (answer.times || answer.available_times)) || [];
  const nums = list.map((t) => (typeof t === 'object' && t ? t.time ?? t.name : t)).filter((t) => t !== null && t !== undefined && String(t) !== '0');
  if (!nums.length) return null;
  return nums.reduce((a, b) => (Number(b) > Number(a) ? b : a));
}

/** Why a plan's mesh is not generated: its estimated cells (mesh_plan.py) over `maxCells`; '' when it may be. */
export function estimateTooBig(plan, maxCells) {
  const est = Number(plan?.mesh?.estimate?.n_cells);
  if (!(maxCells > 0) || !Number.isFinite(est) || est <= maxCells) return '';
  return `the plan estimates about ${est} cells, over the ${maxCells} allowed (MAGNUSIM_VALIDATION_MAX_CELLS): not generated`;
}

/** A mesh answer's live result (GET /api/mesh?mesh_id). */
export function liveMesh(answer) {
  const m = (answer && answer.mesh) || {};
  return m.live_mesh_result || {};
}

/** The run of a /api/run/status answer with this id. */
export function runOf(answer, runId) {
  if (!answer) return null;
  const run = answer.run && String(answer.run.run_id || answer.run.id) === String(runId) ? answer.run : null;
  return run || (answer.runs || []).find((r) => String(r.id || r.run_id) === String(runId)) || null;
}

/**
 * One compared quantity of a result in a line of the run's log: its value against the
 * reference, the error (in per cent, or in the quantity's own unit where the reference is
 * zero and the band absolute) and its verdict.
 */
export function quantityLine(q) {
  const value = q.value === null || q.value === undefined ? 'missing' : Number(q.value).toPrecision(5);
  let err = '-';
  if (q.error && q.error.rel_pct !== null && q.error.rel_pct !== undefined) err = `${Number(q.error.rel_pct).toFixed(2)} %`;
  else if (q.error && q.error.abs !== null && q.error.abs !== undefined) err = `${Number(q.error.abs) >= 0 ? '+' : ''}${Number(q.error.abs).toPrecision(3)}${q.unit ? ` ${q.unit}` : ''}`;
  return `${q.key} ${value} vs ${q.reference.value} (${err}, ${q.verdict})`;
}

/**
 * Whether a run may use the mesh an earlier run of its case made (`plan.mesh_from`: a variant
 * whose geometry, fluid, BCs and mesh are the same as this one's; only its study settings and
 * run differ, as for two turbulence models on one mesh). Given that variant's plan and
 * driver.json (from its folder beside this one), returns its ids, or why not ('' reasons are
 * never returned: a reason is always words).
 */
export function sharedMeshOf(plan, source) {
  const from = plan?.mesh_from;
  if (!from) return { reason: 'the plan meshes its own' };
  const { plan: srcPlan, driver } = source || {};
  if (!srcPlan || !driver) return { reason: `no run of ${from.variant} beside this one` };
  if (srcPlan.mesh_key !== from.key) return { reason: `${from.variant}'s plan is not the same geometry, fluid, BCs and mesh` };
  if (!!srcPlan.coarse !== !!plan.coarse) return { reason: `${from.variant}'s run was ${srcPlan.coarse ? '' : 'not '}coarse` };
  const ids = driver.ids || {};
  if (!ids.project_id || !ids.simulation_id || !ids.mesh_id || !ids.mesh_case_dir) return { reason: `${from.variant}'s run left no mesh` };
  const meshed = (driver.steps || []).some((s) => s.step === 'run-settings' || s.step === 'mesh-facts');
  if (!meshed || (driver.failed_step && ['setup', 'project', 'import', 'faces', 'study', 'material', 'bcs', 'mesh-settings', 'refinements', 'mesh'].includes(driver.failed_step))) {
    return { reason: `${from.variant}'s run stopped before its mesh was done` };
  }
  return { ids: { project_id: ids.project_id, geometry_id: ids.geometry_id, simulation_id: ids.simulation_id, mesh_id: ids.mesh_id, mesh_case_dir: ids.mesh_case_dir }, variant: from.variant };
}

/**
 * The plan's result controls with each `"@bc:<name>"` among a control's boundaries (a Forces
 * monitor on a BC) turned into that BC's id, as the Monitors dialog stores it. `bcIds` maps the
 * plan's BC names to the ids their saves answered; `missing` names the BCs it has no id of.
 */
export function resultControlsWithBcs(controls, bcIds) {
  const missing = [];
  const out = (controls || []).map((rc) => {
    if (!Array.isArray(rc.boundaries)) return rc;
    const boundaries = rc.boundaries.map((b) => {
      const m = /^@bc:(.+)$/.exec(String(b));
      if (!m) return b;
      const id = bcIds && bcIds[m[1]];
      if (!id) missing.push(m[1]);
      return id || b;
    });
    return { ...rc, boundaries };
  });
  return { controls: out, missing };
}

/**
 * What a run's read-back compares of the plan's run settings: a steady run's iteration limit,
 * write interval and cores; a transient run's cores and its transient block (end time, frames,
 * time step, scheme, correctors, averaging) as sent.
 */
export function runSettingsSent(run) {
  const r = run || {};
  if (r.transient && typeof r.transient === 'object') return { cores: r.cores, transient: { ...r.transient } };
  return { endTime: r.endTime, writeInterval: r.writeInterval, cores: r.cores };
}

/**
 * The iteration (steady) or time (transient) a run has reached, as text: what the solve's stall
 * check watches. A transient run's `iteration` is its time rounded (it stood at "1" for longer
 * than the stall limit at 4 cores), so its time and its count of steps come first when the
 * status gives them.
 */
export function runProgress(run) {
  if (!run) return '';
  const p = run.progress || {};
  const t = run.sim_time ?? p.sim_time ?? p.time ?? run.last_time;
  const steps = run.n_steps ?? p.n_steps;
  const it = run.iteration ?? p.iteration;
  const at = t ?? it;
  if (steps !== undefined && steps !== null) return `${at === undefined || at === null ? '' : at} (${steps} steps)`.trim();
  return at === undefined || at === null ? '' : String(at);
}

/**
 * The validation set's own outputs (repository paths): a run rewrites or deletes them, so they
 * never count as the tree having changes.
 */
export const OWN_OUTPUTS = ['magnusim-web/validation/results', 'magnusim-web/validation/VALIDATION.md', 'docs/validation', 'docs/.nojekyll'];

/** The commit, its description, whether the tree has changes (the set's own outputs aside), and the branch (git in `cwd`). */
export function gitFacts(cwd) {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  const status = git(['status', '--porcelain', '--untracked-files=no', '--', ':(top)', ...OWN_OUTPUTS.map((p) => `:(top,exclude)${p}`)]);
  const dirty = status === null ? null : status.length > 0;
  const describe = git(['describe', '--tags', '--always']);
  return {
    commit: git(['rev-parse', 'HEAD']),
    describe: describe && dirty ? `${describe}-dirty` : describe,
    dirty,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

/** WSL's load average (1, 5, 15 min) and its CPU count, or null. */
export function wslLoad(distro = process.env.MAGNUSIM_WSL_DISTRO || 'Ubuntu-24.04') {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('wsl.exe', ['-d', distro, '-e', 'bash', '-c', 'cat /proc/loadavg; nproc'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.status !== 0) return null;
  const [line, n] = String(r.stdout).trim().split(/\r?\n/);
  const [a, b, c] = String(line || '').split(/\s+/).map(Number);
  return { load_1min: a, load_5min: b, load_15min: c, cpus: Number(n) || null };
}

/**
 * Run one plan against the app at `base` with Playwright's `request` fixture.
 * @param {object} o
 * @param {import('@playwright/test').APIRequestContext} o.request
 * @param {string} o.dir        the run's folder (plan.json, geometry.step; raw/ and driver.json go here)
 * @param {string} o.webRoot    magnusim-web (git facts, versions)
 * @param {(msg: string) => void} [o.log]
 * @param {boolean} [o.meshOnly] stop after the mesh and its facts
 * @param {number} [o.maxCells] refuse to Generate when the plan's estimated mesh is bigger
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @returns {Promise<object>} driver.json's content (also written)
 */
export async function runPlan({ request, dir, webRoot, log = console.log, meshOnly = false, maxCells = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  const rawDir = join(dir, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const t0 = Date.now();
  const drv = {
    schema: 'magnusim-validation-driver/1',
    case: plan.case,
    variant: plan.variant,
    started_at: new Date().toISOString(),
    finished_at: null,
    outcome: 'running',
    failed_step: null,
    error: null,
    ids: {},
    timings_s: {},
    steps: [],
    app: { ...gitFacts(webRoot), app_version: null, incompressible_flow: null, pc: { cpus: cpus().length } },
    mesh_only: !!meshOnly,
  };
  try {
    drv.app.app_version = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')).version || null;
    const manifest = readFileSync(join(webRoot, 'bundled-plugins', 'incompressible_flow', 'manifest.toml'), 'utf8');
    drv.app.incompressible_flow = (/^\s*version\s*=\s*"([^"]+)"/m.exec(manifest) || [])[1] || null;
  } catch {
    /* recorded as null */
  }
  const writeDriver = () => writeFileSync(join(dir, 'driver.json'), JSON.stringify(drv, null, 1) + '\n');
  const stage = (msg) => log(`STAGE +${Math.round((Date.now() - t0) / 1000)}s ${plan.case}/${plan.variant} ${msg}`);
  const save = (name, doc) => writeFileSync(join(rawDir, `${name}.json`), JSON.stringify(doc, null, 1) + '\n');
  let current = 'setup';
  const step = (name) => {
    current = name;
    drv.steps.push({ step: name, at_s: Math.round((Date.now() - t0) / 100) / 10 });
    writeDriver();
  };
  const fail = (msg) => {
    const e = new Error(msg);
    e.validationStep = current;
    throw e;
  };
  const q = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  // A poll can reuse a keep-alive socket just as the server closes it: a read is retried.
  const getJson = async (path, params = {}, { ok = true } = {}) => {
    for (let i = 0; ; i++) {
      try {
        const r = await request.get(`${path}?${q(params)}`, { timeout: 120_000 });
        const body = await r.json().catch(async () => ({ _text: (await r.text().catch(() => '')).slice(0, 2000) }));
        if (ok && !r.ok()) fail(`GET ${path} answered ${r.status()}: ${JSON.stringify(body).slice(0, 600)}`);
        return { status: r.status(), body };
      } catch (e) {
        if (i >= 3 || !/ECONNRESET|socket hang up|ECONNREFUSED/i.test(String(e))) throw e;
        await sleep(1000);
      }
    }
  };
  // Writes are sent once (a write retried after a reset could land twice).
  const postJson = async (path, data, { ok = true, params = null } = {}) => {
    const r = await request.post(params ? `${path}?${q(params)}` : path, { data, timeout: 600_000 });
    const body = await r.json().catch(async () => ({ _text: (await r.text().catch(() => '')).slice(0, 2000) }));
    if (ok && !r.ok()) fail(`POST ${path} answered ${r.status()}: ${JSON.stringify(body).slice(0, 600)}`);
    return { status: r.status(), body };
  };
  const timed = async (name, fn) => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      drv.timings_s[name] = Math.round((Date.now() - s) / 100) / 10;
    }
  };
  const poll = async (label, probe, { timeoutS, intervalS = 5, stallS = 0, progressOf = null }) => {
    const end = Date.now() + timeoutS * 1000;
    let last = '';
    let beat = Date.now();
    let moved = Date.now();
    let lastProgress = null;
    for (;;) {
      const v = await probe();
      if (v.log !== last || Date.now() - beat > 60_000) {
        stage(`${label}: ${v.log}`);
        last = v.log;
        beat = Date.now();
      }
      if (v.done) return v;
      if (progressOf) {
        const p = progressOf(v);
        if (p !== lastProgress) {
          lastProgress = p;
          moved = Date.now();
        } else if (stallS && Date.now() - moved > stallS * 1000) fail(`${label}: stalled at ${p} for ${stallS} s`);
      }
      if (Date.now() > end) fail(`${label}: not done after ${timeoutS} s (last: ${last})`);
      await sleep(intervalS * 1000);
    }
  };

  const ids = drv.ids;
  // The mesh of an earlier variant of this case (two turbulence models on one mesh): reused
  // when that variant's run is beside this one, made by this server, and its mesh is still
  // there; otherwise this run makes its own, the same way.
  const readSource = () => {
    if (!plan.mesh_from) return null;
    const srcDir = join(dir, '..', plan.mesh_from.variant);
    try {
      return { plan: JSON.parse(readFileSync(join(srcDir, 'plan.json'), 'utf8')), driver: JSON.parse(readFileSync(join(srcDir, 'driver.json'), 'utf8')), dir: srcDir };
    } catch {
      return null;
    }
  };
  try {
    let shared = sharedMeshOf(plan, readSource());
    if (shared.ids) {
      const s = shared.ids;
      const proj = await getJson('/api/project', { project_id: s.project_id }, { ok: false });
      const meshNow = proj.status === 200 ? await getJson('/api/mesh', { project_id: s.project_id, simulation_id: s.simulation_id, mesh_id: s.mesh_id }, { ok: false }) : null;
      const liveNow = meshNow && meshNow.status === 200 ? liveMesh(meshNow.body) : {};
      if (proj.status !== 200) shared = { reason: `${shared.variant}'s project is not on this server (it starts with an empty projects root)` };
      else if (liveNow.status !== 'done' || !existsSync(join(s.mesh_case_dir, 'mesh-facts.json'))) shared = { reason: `${shared.variant}'s mesh is ${liveNow.status || 'gone'}` };
    }
    drv.mesh_shared = shared.ids ? { from: shared.variant, ...shared.ids } : { from: null, reason: shared.reason };
    if (plan.mesh_from) stage(shared.ids ? `the mesh of ${shared.variant} (project ${shared.ids.project_id})` : `meshing its own: ${shared.reason}`);
    if (shared.ids) {
      Object.assign(ids, shared.ids);
      const pid = ids.project_id;
      const sid = ids.simulation_id;
      const mid = ids.mesh_id;
      // 4. The study's settings for this run (the rest is the earlier variant's, the same as this plan's).
      step('study');
      await postJson('/api/simulation/update', { project_id: pid, simulation_id: sid, ...plan.study.settings });
      const sims = await getJson('/api/simulation', { project_id: pid, simulation_id: sid });
      save('study', sims.body);
      const study = (sims.body.simulations || []).find((x) => String(x.id) === sid) || sims.body.simulation || {};
      const studyProblems = readBackProblems({ analysis_type: plan.study.analysis_type, ...plan.study.settings }, study);
      if (studyProblems.length) fail(`the study did not keep its settings: ${studyProblems.join('; ')}`);
      // 9-10. The mesh as it stands, and its facts.
      step('mesh-facts');
      const meshNow = await getJson('/api/mesh', { project_id: pid, simulation_id: sid, mesh_id: mid });
      save('mesh', meshNow.body);
      save('mesh-facts', JSON.parse(readFileSync(join(ids.mesh_case_dir, 'mesh-facts.json'), 'utf8')));
      for (const f of ['blockMeshDict', 'snappyHexMeshDict']) {
        const fp = join(ids.mesh_case_dir, 'system', f);
        if (existsSync(fp)) writeFileSync(join(rawDir, `${f}.txt`), readFileSync(fp));
      }
      if (meshOnly) {
        drv.outcome = 'mesh_only';
        return drv;
      }
      return await runAndRead(pid, sid, mid);
    }

    // 1. The project.
    step('project');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const made = await postJson('/api/project', { ...plan.project, title: `${plan.project.title} ${stamp}` });
    save('project', made.body);
    ids.project_id = String(made.body.id || made.body.project?.id || '');
    if (!ids.project_id) fail(`no project id in ${JSON.stringify(made.body).slice(0, 300)}`);
    const pid = ids.project_id;
    stage(`project ${pid}`);

    // 2. The STEP, uploaded as the page and the Assistant's import do (the file is the body).
    step('import');
    const bytes = readFileSync(join(dir, plan.geometry.file));
    const imported = await timed('import', async () => {
      const r = await request.post(`/api/geometry/import?${q({ project_id: pid, filename: `${plan.case}.step` })}`, {
        data: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 600_000,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok()) fail(`import answered ${r.status()}: ${JSON.stringify(body).slice(0, 600)}`);
      return body;
    });
    save('import', imported);
    ids.geometry_id = String(imported.active_geometry_id || imported.geometry?.id || imported.added?.id || '');
    if (!ids.geometry_id) fail('the import gave no geometry id');
    const proj = await getJson('/api/project', { project_id: pid });
    if ((proj.body.project?.geometries || []).length !== 1) fail(`the project has ${(proj.body.project?.geometries || []).length} geometries after the import`);

    // 3. The app's face table of the imported part, against the plan's.
    step('faces');
    const meta = await timed('faces', async () => {
      for (let i = 0; i < 120; i++) {
        const r = await request.get(`/api/geometry/cad?${q({ project_id: pid, geometry_id: ids.geometry_id, part: 'meta' })}`, { timeout: 120_000 });
        if (r.status() === 200) {
          const body = await r.json();
          if (Array.isArray(body.faces)) return body;
        } else if (r.status() !== 202) fail(`face table answered ${r.status()}: ${(await r.text()).slice(0, 400)}`);
        await sleep(2000);
      }
      return fail('the face table was not ready within 4 minutes');
    });
    save('faces', { faces: meta.faces, faces_length_unit: meta.faces_length_unit ?? null });
    const faceProblems = faceTableProblems(plan.geometry.faces, meta.faces);
    if (faceProblems.length) fail(`face numbering differs from the app's face table: ${faceProblems.join('; ')}`);

    // 4. The study and its settings.
    step('study');
    const sim = await postJson('/api/simulation', {
      project_id: pid,
      geometry_id: ids.geometry_id,
      analysis_type: plan.study.analysis_type,
      time_dependency: plan.study.time_dependency,
      activate: true,
    });
    ids.simulation_id = String(sim.body.simulation?.id || sim.body.id || '');
    if (!ids.simulation_id) fail(`no study id in ${JSON.stringify(sim.body).slice(0, 300)}`);
    const sid = ids.simulation_id;
    await postJson('/api/simulation/update', { project_id: pid, simulation_id: sid, name: plan.study.name, ...plan.study.settings });
    const sims = await getJson('/api/simulation', { project_id: pid, simulation_id: sid });
    save('study', sims.body);
    const study = (sims.body.simulations || []).find((s) => String(s.id) === sid) || sims.body.simulation || {};
    const studyProblems = readBackProblems({ name: plan.study.name, analysis_type: plan.study.analysis_type, ...plan.study.settings }, study);
    if (studyProblems.length) fail(`the study did not keep its settings: ${studyProblems.join('; ')}`);

    // 5. The fluid.
    step('material');
    const { assigned_volumes: volumes, ...fluid } = plan.material;
    await postJson('/api/materials', { project_id: pid, simulation_id: sid, ...fluid, assigned_volumes: volumes });
    const mats = await getJson('/api/materials', { project_id: pid, simulation_id: sid });
    save('materials', mats.body);
    const mat = (mats.body.materials || []).find((m) => m.name === plan.material.name) || {};
    const matProblems = readBackProblems(
      { name: fluid.name, kinematic_viscosity: fluid.kinematic_viscosity, density: fluid.density, assigned_volumes: volumes },
      mat,
    );
    if (matProblems.length) fail(`the fluid was not saved as sent: ${matProblems.join('; ')}`);

    // 6. The BCs, one by one; then all of them read back.
    step('bcs');
    ids.bcs = {};
    for (const bc of plan.bcs) {
      const r = await postJson('/api/bcs', { project_id: pid, simulation_id: sid, geometry_id: ids.geometry_id, ...bc });
      ids.bcs[bc.name] = String(r.body.bc?.id || r.body.id || '');
    }
    const bcs = await getJson('/api/bcs', { project_id: pid, simulation_id: sid });
    save('bcs', bcs.body);
    const stored = bcs.body.boundary_conditions || [];
    const bcProblems = [];
    for (const bc of plan.bcs) {
      const rec = stored.find((b) => b.name === bc.name);
      if (!rec) bcProblems.push(`${bc.name}: not saved`);
      else bcProblems.push(...readBackProblems(bc, rec, `${bc.name}.`));
    }
    if (stored.length !== plan.bcs.length) bcProblems.push(`the study has ${stored.length} BCs, the plan ${plan.bcs.length}`);
    if (bcProblems.length) fail(`the BCs were not saved as sent: ${bcProblems.join('; ')}`);

    // 7. The mesh record and its settings (a new study's own mesh, else a new one).
    step('mesh-settings');
    const meshes = await getJson('/api/mesh', { project_id: pid, simulation_id: sid });
    save('mesh-list', meshes.body);
    const have = (meshes.body.meshes || []).filter((m) => m && m.id);
    if (have.length) ids.mesh_id = String(have[0].id);
    else {
      const created = await postJson('/api/mesh', { project_id: pid, simulation_id: sid, create: true, name: plan.mesh.name });
      ids.mesh_id = String(created.body.mesh?.id || created.body.id || '');
    }
    if (!ids.mesh_id) fail('no mesh id');
    const mid = ids.mesh_id;
    await postJson('/api/mesh', { project_id: pid, simulation_id: sid, mesh_id: mid, name: plan.mesh.name, ...plan.mesh.settings });
    const meshDoc = await getJson('/api/mesh', { project_id: pid, simulation_id: sid, mesh_id: mid });
    save('mesh-settings', meshDoc.body);
    const settingsProblems = readBackProblems(plan.mesh.settings, meshDoc.body.mesh?.settings || {});
    if (settingsProblems.length) fail(`the mesh settings were not saved as sent: ${settingsProblems.join('; ')}`);

    // 8. Its refinements.
    step('refinements');
    for (const ref of plan.mesh.refinements || []) {
      await postJson('/api/mesh/refinements', { project_id: pid, simulation_id: sid, mesh_id: mid, faces_explicit: true, ...ref });
    }
    const refs = await getJson('/api/mesh/refinements', { project_id: pid, simulation_id: sid });
    save('refinements', refs.body);
    const refList = (refs.body.refinements || refs.body.mesh_refinements || []).filter((r) => String(r.mesh_id || '') === mid);
    const refProblems = [];
    for (const ref of plan.mesh.refinements || []) {
      const rec = refList.find((r) => r.name === ref.name);
      if (!rec) refProblems.push(`${ref.name}: not saved`);
      else refProblems.push(...readBackProblems(ref, rec, `${ref.name}.`));
    }
    if (refProblems.length) fail(`the refinements were not saved as sent: ${refProblems.join('; ')}`);

    // 9. Generate, and wait for the mesh (never one the plan estimates too big for the PC).
    step('mesh');
    const tooBig = estimateTooBig(plan, maxCells);
    if (tooBig) fail(tooBig);
    const gen = await postJson('/api/mesh/generate', { project_id: pid, simulation_id: sid, mesh_id: mid, queue_if_busy: true }, { ok: false });
    save('mesh-generate', { status: gen.status, body: gen.body });
    if (gen.status >= 300) fail(`Generate answered ${gen.status}: ${JSON.stringify(gen.body).slice(0, 600)}`);
    const meshT0 = Date.now();
    const meshEnd = await timed('mesh', () =>
      poll(
        'mesh',
        async () => {
          const a = await getJson('/api/mesh', { project_id: pid, simulation_id: sid, mesh_id: mid });
          const live = liveMesh(a.body);
          const st = String(live.status || 'none');
          if (st === 'none' && Date.now() - meshT0 > 90_000) fail('no mesh job within 90 s of Generate');
          return { done: /^(done|failed|stopped)$/.test(st), log: `${st} ${live.stage || ''}`.trim(), answer: a.body };
        },
        { timeoutS: plan.timeouts_s?.mesh || 1800, intervalS: 5 },
      ),
    );
    save('mesh', meshEnd.answer);
    const live = liveMesh(meshEnd.answer);
    if (live.status !== 'done') fail(`the mesh ${live.status}: ${JSON.stringify(live.error || live.log_excerpt || '').slice(0, 800)}`);
    ids.mesh_case_dir = live.case_dir || meshEnd.answer.mesh?.case_dir || null;
    stage(`mesh done: ${live.n_cells} cells, layers_applied ${live.layers_applied}`);

    // 10. The mesh's facts (RH2's mesh-facts.json beside it).
    step('mesh-facts');
    const factsPath = ids.mesh_case_dir ? join(ids.mesh_case_dir, 'mesh-facts.json') : null;
    if (factsPath && existsSync(factsPath)) save('mesh-facts', JSON.parse(readFileSync(factsPath, 'utf8')));
    else save('mesh-facts', { missing: true, path: factsPath });
    for (const f of ['blockMeshDict', 'snappyHexMeshDict']) {
      const p = ids.mesh_case_dir ? join(ids.mesh_case_dir, 'system', f) : null;
      if (p && existsSync(p)) writeFileSync(join(rawDir, `${f}.txt`), readFileSync(p));
    }
    if (meshOnly) {
      drv.outcome = 'mesh_only';
      return drv;
    }
    return await runAndRead(pid, sid, mid);
  } catch (e) {
    drv.outcome = 'failed';
    drv.failed_step = e.validationStep || current;
    drv.error = String((e && e.message) || e);
    throw e;
  } finally {
    drv.finished_at = new Date().toISOString();
    drv.timings_s.total = Math.round((Date.now() - t0) / 100) / 10;
    drv.plan_file = basename(join(dir, 'plan.json'));
    writeDriver();
  }

  /** Steps 11 to 15 on the study's mesh: the run, its gate and pre-run check, Start, and what the run's routes give. */
  async function runAndRead(pid, sid, mid) {
    // 11. The run and its settings.
    step('run-settings');
    const run = await postJson('/api/run/create', { project_id: pid, simulation_id: sid, name: plan.run.name, mesh_id: mid });
    ids.run_id = String(run.body.run_id || run.body.run?.id || run.body.run?.run_id || '');
    if (!ids.run_id) fail(`no run id in ${JSON.stringify(run.body).slice(0, 300)}`);
    const rid = ids.run_id;
    // A Forces monitor names its BC by the id its save answered (the Monitors dialog's record).
    const { controls, missing } = resultControlsWithBcs(plan.run.result_controls, ids.bcs || {});
    if (missing.length) fail(`no BC id for the result controls' ${missing.join(', ')}`);
    const runSettings = { ...plan.run, result_controls: controls };
    delete runSettings.name;
    await postJson('/api/run/update', { project_id: pid, simulation_id: sid, run_id: rid, ...runSettings });
    const runDoc = runOf((await getJson('/api/run/status', { project_id: pid, simulation_id: sid, run_id: rid })).body, rid);
    save('run-settings', runDoc || {});
    const runProblems = readBackProblems({ ...runSettingsSent(plan.run), mesh_id: mid }, runDoc || {});
    const rcs = (runDoc && runDoc.result_controls) || [];
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    for (const rc of controls) {
      if (!rcs.some((x) => x.id === rc.id && same(x.points, rc.points) && same(x.boundaries, rc.boundaries))) runProblems.push(`result control ${rc.name}: not saved as sent`);
    }
    if (runProblems.length) fail(`the run settings were not saved as sent: ${runProblems.join('; ')}`);

    // 12. The Start gate, and the pre-run check (RH2).
    step('ready');
    const ready = await getJson('/api/run/ready', { project_id: pid, simulation_id: sid, run_id: rid, mesh_id: mid });
    save('ready', ready.body);
    if ((ready.body.issues || []).length) fail(`Start is blocked: ${ready.body.issues.map((i) => i.message || JSON.stringify(i)).join('; ')}`);
    const pre = await postJson('/api/run/precheck', { project_id: pid, simulation_id: sid, run_id: rid }, { ok: false });
    save('precheck', { status: pre.status, body: pre.body });

    // 13. Start, and wait for the solve (bounded; a run whose iteration stands still for 5 minutes fails).
    step('solve');
    drv.app.pc.wsl_before = wslLoad();
    const started = await postJson('/api/run/start', { project_id: pid, simulation_id: sid, run_id: rid }, { ok: false });
    save('run-start', { status: started.status, body: started.body });
    if (started.status >= 300) fail(`Start answered ${started.status}: ${JSON.stringify(started.body).slice(0, 600)}`);
    let wslMid = null;
    const solveT0 = Date.now();
    const solved = await timed('solve', () =>
      poll(
        'solve',
        async () => {
          const a = await getJson('/api/run/status', { project_id: pid, simulation_id: sid, run_id: rid });
          const r = runOf(a.body, rid) || {};
          // WSL's load once the solve is under way: the run times compare only like with like.
          if (!wslMid && Date.now() - solveT0 > 8_000) wslMid = wslLoad();
          return { done: /^(done|failed|stopped|finished)$/.test(String(r.status || '')), log: `${r.status || 'none'} ${runProgress(r)}`.trim(), run: r };
        },
        { timeoutS: plan.timeouts_s?.solve || 5400, intervalS: 10, stallS: 300, progressOf: (v) => `${v.run.status} ${runProgress(v.run)}` },
      ),
    );
    drv.app.pc.wsl_during = wslMid;
    drv.app.pc.wsl_after = wslLoad();
    const status = await getJson('/api/run/status', { project_id: pid, simulation_id: sid, run_id: rid });
    save('run-status', status.body);
    const finalRun = runOf(status.body, rid) || solved.run;
    ids.run_case_dir = finalRun.case_dir || null;

    // 14. What the run's own routes say: monitors, health, the solver log, the saved times.
    step('results');
    save('monitors', (await getJson('/api/run/monitors', { project_id: pid, simulation_id: sid, run_id: rid }, { ok: false })).body);
    let health = null;
    for (let i = 0; i < 60; i++) {
      health = await getJson('/api/run/health', { project_id: pid, simulation_id: sid, run_id: rid, recompute: '1' }, { ok: false });
      if (!(health.body && health.body.checking)) break;
      await sleep(2000);
    }
    save('health', health ? health.body : null);
    save('solver-log-start', (await getJson('/api/run/solver-log', { project_id: pid, simulation_id: sid, run_id: rid, at: 'start', lines: 60 }, { ok: false })).body);
    save('solver-log-end', (await getJson('/api/run/solver-log', { project_id: pid, simulation_id: sid, run_id: rid, at: 'end', lines: 80 }, { ok: false })).body);
    if (finalRun.status !== 'done' && finalRun.status !== 'finished') fail(`the run ${finalRun.status}: ${JSON.stringify(finalRun.error || finalRun.log_excerpt || '').slice(-800)}`);
    const times = await getJson('/api/times', { project_id: pid, case: ids.run_case_dir }, { ok: false });
    save('times', times.body);
    const latest = latestTime(times.body);
    if (latest === null) fail(`the run saved no time: ${JSON.stringify(times.body).slice(0, 300)}`);
    ids.latest_time = String(latest);

    // 15. The lines (Plot over path, as the Results panel asks for it).
    step('lines');
    await timed('lines', async () => {
      for (const ex of plan.extract || []) {
        if (ex.kind !== 'line') continue;
        const a = await getJson(
          '/api/plot-over-path',
          { project_id: pid, case: ids.run_case_dir, time: ex.time && ex.time !== 'latest' ? ex.time : latest, points: pointsParam(ex.points_m), subdivisions: ex.subdivisions, field: ex.field },
          { ok: false },
        );
        save(`line_${ex.key}`, { status: a.status, ...a.body });
        stage(`line ${ex.key}: ${a.status} ${a.body?.n_valid ?? ''} samples ${a.body?.reason || a.body?.error || ''}`.trim());
      }
    });
    drv.outcome = 'done';
    return drv;
  }
}
