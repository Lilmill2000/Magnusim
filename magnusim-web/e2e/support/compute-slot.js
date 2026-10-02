// The one compute slot (H15) as browser tests see it: wait until no job holds it,
// find a server's queue and plugin-case files, and keep a WSL case copy "live".
//
//   import { waitSlotFree } from './support/compute-slot.js';
//   await waitSlotFree(request);                      // the main test server
//   await waitSlotFree(request, { base: host.base }); // a startHost() server
//
// A stop that ends in a drain holds the slot until the run's WSL processes are
// gone, so a Start right after a Stop may read "Add to queue" until then.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wslBash } from '../toolchain.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_DIR = join(WEB_ROOT, 'python');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The venv's python (scripts/python-env.js), without importing the app's server modules. */
function venvPython() {
  if (process.env.MAGNUSIM_PYTHON) return process.env.MAGNUSIM_PYTHON;
  const win = join(PY_DIR, '.venv', 'Scripts', 'python.exe');
  return existsSync(win) ? win : join(PY_DIR, '.venv', 'bin', 'python');
}

/** The server's queue (every project), or null when it did not answer. */
export async function computeQueue(request, { base = '' } = {}) {
  try {
    const r = await request.get(`${base}/api/compute-queue`);
    return r.ok() ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Wait until no job holds the compute slot (`busy` is null); throws after timeoutMs. */
export async function waitSlotFree(request, { base = '', timeoutMs = 180_000, intervalMs = 1_000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    const q = await computeQueue(request, { base });
    if (q) {
      last = q.busy || null;
      if (!last) return;
    }
    if (Date.now() > until) throw new Error(`the compute slot is still held after ${timeoutMs} ms: ${JSON.stringify(last)}`);
    await sleep(intervalMs);
  }
}

/** The tag a server gives a projects root that is not the checkout's own (computeQueueFileFor). */
function rootTag(projectsRoot) {
  return createHash('sha1').update(resolve(projectsRoot).toLowerCase()).digest('hex').slice(0, 10);
}

/** Where a server on `projectsRoot` keeps its compute queue (scripts/server/compute-queue.ts computeQueueFileFor). */
export function queueFileFor(projectsRoot, webRoot = WEB_ROOT) {
  const root = resolve(projectsRoot);
  if (root.toLowerCase() === resolve(webRoot, 'projects').toLowerCase()) return join(webRoot, '.cache', 'compute-queue.json');
  return join(webRoot, '.cache', `compute-queue-${rootTag(root)}.json`);
}

/** Where a server on `projectsRoot` keeps its plugin cases (scripts/foam-store.js foamStoreFileFor). */
export function foamStoreFileFor(projectsRoot, webRoot = WEB_ROOT) {
  const root = resolve(projectsRoot);
  if (root.toLowerCase() === resolve(webRoot, 'projects').toLowerCase()) return join(webRoot, '.cache', 'foam-cases.json');
  return join(webRoot, '.cache', `foam-cases-${rootTag(root)}.json`);
}

/**
 * Start a process in WSL that lives in a case copy for 10 minutes: its cwd and its
 * command line both name <root>/<caseId>, so the app's probe sees the case as live
 * even after solve.sh removed the copy. `bash -c 'sleep 600; true'` keeps bash from
 * exec'ing sleep, so the named script stays in the command line.
 */
export function plantCaseHolder(wslRoot, caseId) {
  const dir = `${wslRoot}/${caseId}`;
  // The child must have reached setsid before this shell exits, or it dies with it:
  // wait until it shows in /proc (no grep: its own command line would name the path).
  const script = [
    'd="$1"',
    'mkdir -p "$d" && cd "$d" || exit 3',
    "setsid nohup bash -c 'sleep 600; true' \"$d/hold\" >/dev/null 2>&1 </dev/null &",
    'for i in $(seq 1 100); do',
    '  for p in /proc/[0-9]*; do',
    '    c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue',
    '    case "$c" in "bash -c sleep 600; true $d/hold"*) echo planted; exit 0 ;; esac',
    '  done',
    '  sleep 0.1',
    'done',
    'exit 4',
  ].join('\n');
  const r = wslBash(script, [dir], 60_000);
  if (r.status !== 0 || !/planted/.test(String(r.stdout || ''))) {
    throw new Error(`could not plant a holder in ${dir} (status ${r.status}): ${r.stdout || ''} ${r.stderr || ''}`);
  }
}

/**
 * Start a process in WSL named `name` (exec -a), with a case copy as its cwd, for 10 minutes:
 * a stand-in for a solver step left running (say reconstructPar) that only the cwd ties to the case.
 */
export function plantNamedProcess(dir, name) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`not a plain process name: ${name}`);
  const script = [
    'd="$1"; n="$2"',
    'mkdir -p "$d" && cd "$d" || exit 3',
    'setsid nohup bash -c "exec -a $n sleep 600" >/dev/null 2>&1 </dev/null &',
    'for i in $(seq 1 100); do',
    '  for p in /proc/[0-9]*; do',
    '    c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null) || continue',
    '    case "$c" in "$n 600"*) [ "$(readlink "$p/cwd" 2>/dev/null)" = "$d" ] && { echo planted; exit 0; } ;; esac',
    '  done',
    '  sleep 0.1',
    'done',
    'exit 4',
  ].join('\n');
  const r = wslBash(script, [dir, name], 60_000);
  if (r.status !== 0 || !/planted/.test(String(r.stdout || ''))) {
    throw new Error(`could not start ${name} in ${dir} (status ${r.status}): ${r.stdout || ''} ${r.stderr || ''}`);
  }
}

/** Processes in WSL whose cwd or command line is under `dir` (pid and command line), for checks and clean-up. */
export function wslProcessesUnder(dir) {
  // The folder goes in base64: a scan whose own command line named the case copy is a
  // process "under" it, and the app's case kill (wsl_case_procs.py) would end the scan.
  const script = [
    'me=$$',
    'd=$(printf "%s" "$1" | base64 -d) || exit 9',
    'for p in /proc/[0-9]*; do',
    '  pid=${p#/proc/}',
    '  [ "$pid" = "$me" ] && continue',
    '  [ "$pid" = "$PPID" ] && continue',
    '  cwd=$(readlink "$p/cwd" 2>/dev/null) || cwd=""',
    '  cmd=$(tr "\\0" " " 2>/dev/null < "$p/cmdline") || cmd=""',
    '  case "$cmd" in *wsl-procs-under*) continue ;; esac',
    '  case "$cwd" in "$d"|"$d"/*) echo "$pid $cmd"; continue ;; esac',
    '  case "$cmd" in *"$d"*) echo "$pid $cmd" ;; esac',
    'done',
    'exit 0',
  ].join('\n');
  const r = wslBash(script, [Buffer.from(String(dir), 'utf8').toString('base64'), 'wsl-procs-under'], 30_000);
  if (r.status !== 0) throw new Error(`WSL process list failed (status ${r.status}): ${r.stderr || ''}`);
  return String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** End every WSL process whose cwd or command line is under `dir` (a test's own WSL root only). */
export function killWslProcessesUnder(dir) {
  for (const line of wslProcessesUnder(dir)) {
    const pid = line.split(' ')[0];
    wslBash('kill -9 "$1" 2>/dev/null; true', [pid], 15_000);
  }
}

/** GET JSON, retrying a socket the server closed between polls. */
export async function getJson(request, url) {
  for (let i = 0; ; i++) {
    try {
      return await (await request.get(url)).json();
    } catch (e) {
      if (i >= 2 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** Open a seeded elbow project's Mesh 1 settings form (as compute-queue.spec.js does); returns its Generate button. */
export async function openMeshForm(page, projectId, { base = '' } = {}) {
  await page.goto(`${base}/#/p/${encodeURIComponent(projectId)}`);
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, projectId, { timeout: 90_000 });
  const tree = page.locator('#left-tree');
  const meshRow = tree.locator('[data-w20-mesh-item]').first();
  // Open the Mesh folder only when it is closed (a click on an open one closes it).
  const folder = tree.locator('[data-w20-mesh="1"]').first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
    await folder.locator(':scope > .tree-row .tw').first().click();
  }
  await meshRow.click();
  const settingsBtn = page.locator('#mesh-inspect-settings');
  if (await settingsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) await settingsBtn.click();
  await page.locator('#panel-mesh-form').waitFor({ state: 'visible', timeout: 30_000 });
  return page.locator('#panel-mesh-form [data-mesh-generate="1"]');
}

/**
 * Set Mesh 1's fineness (with `quick`, hex core and boundary layers off) and click
 * Generate (or Add to queue). Returns the button's label before the click.
 */
export async function clickGenerate(page, projectId, { base = '', fineness = 1, quick = true, want = null } = {}) {
  const gen = await openMeshForm(page, projectId, { base });
  const form = page.locator('#panel-mesh-form .cfd-island');
  const fine = form.locator('[data-schema-key="fineness"] input');
  await fine.waitFor({ state: 'visible', timeout: 30_000 });
  await fine.fill(String(fineness));
  await fine.press('Enter');
  if (quick) {
    for (const label of ['Hex element core', 'Automatic boundary layers']) {
      const toggle = form.locator(`button[aria-label="${label}"]`);
      if ((await toggle.count()) && (await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    }
  }
  // `want`: the label the button must show before the click ("Add to queue" while the slot is busy).
  if (want) {
    await page.waitForFunction(
      (w) => String(document.querySelector('#panel-mesh-form [data-mesh-generate="1"]')?.textContent || '').trim() === w,
      want,
      { timeout: 30_000 },
    );
  }
  const label = String((await gen.textContent()) || '').trim();
  await gen.click();
  return label;
}

/**
 * Generate Mesh 1 of a seeded elbow project through the API (its saved settings, with
 * `fineness` and, with `quick`, no hex core and no boundary layers). Returns the answer.
 */
export async function startMesh(request, projectId, { base = '', fineness = null, quick = false, queueIfBusy = false } = {}) {
  const settings = {};
  if (fineness != null) settings.fineness = fineness;
  if (quick) Object.assign(settings, { hex_element_core: false, automatic_boundary_layers: false });
  const r = await request.post(`${base}/api/mesh/generate`, {
    data: {
      project_id: projectId,
      simulation_id: 'sim_1',
      mesh_id: 'mesh_1',
      name: 'Mesh 1',
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(queueIfBusy ? { queue_if_busy: true } : {}),
    },
  });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** Stop a project's running mesh job (POST /api/jobs/<id>/stop, as the job's Stop does). */
export async function stopMesh(request, projectId, { base = '' } = {}) {
  const j = await getJson(request, `${base}/api/jobs?project_id=${encodeURIComponent(projectId)}&kind=mesh`);
  const live = (j.jobs || []).filter((x) => x && (x.status === 'running' || x.status === 'queued'));
  for (const job of live) {
    await request.post(`${base}/api/jobs/${encodeURIComponent(job.id)}/stop?project_id=${encodeURIComponent(projectId)}`, { data: {} });
  }
  return live.map((x) => x.id);
}

/** Mesh 1 of a project as /api/mesh lists it. */
export async function meshRow(request, projectId, { base = '', meshId = 'mesh_1' } = {}) {
  const j = await getJson(request, `${base}/api/mesh?project_id=${encodeURIComponent(projectId)}`);
  return (j.meshes || []).find((m) => String(m.id) === meshId) || (j.mesh && String(j.mesh.id) === meshId ? j.mesh : null) || {};
}

/** POST JSON, retrying once when the server closed a kept-alive socket as the request went out. */
export async function postJson(request, url, data, opts = {}) {
  for (let i = 0; ; i++) {
    try {
      return await request.post(url, { data, ...opts });
    } catch (e) {
      if (i >= 1 || !/ECONNRESET|socket hang up/i.test(String(e))) throw e;
    }
  }
}

/** A new draft run in a study (POST /api/run/create); returns its id. */
export async function createRun(request, { base = '', projectId, simulationId = 'sim_1', name }) {
  const r = await postJson(request, `${base}/api/run/create`, { project_id: projectId, simulation_id: simulationId, name }, { timeout: 120_000 });
  const j = await r.json();
  if (!r.ok()) throw new Error(`run create failed: ${JSON.stringify(j)}`);
  const rid = j.run_id || (j.run && (j.run.id || j.run.run_id)) || j.id;
  if (!rid) throw new Error(`run create answered no id: ${JSON.stringify(j)}`);
  return String(rid);
}

/** A run of a study as /api/run/status lists it ({} when it is not there). */
export async function runRow(request, { base = '', projectId, simulationId = 'sim_1', runId }) {
  const j = await getJson(request, `${base}/api/run/status?project_id=${encodeURIComponent(projectId)}&simulation_id=${encodeURIComponent(simulationId)}`);
  return (j.runs || []).find((r) => String(r.id || r.run_id) === String(runId)) || {};
}

/** Open a run's panel from the tree; returns the panel. */
export async function openRunPanel(page, { base = '', projectId, simulationId = 'sim_1', runId, reload = true }) {
  if (reload) {
    await page.goto(`${base}/#/p/${encodeURIComponent(projectId)}`);
    await page.reload();
  }
  await page.waitForFunction((id) => window.__CFD_PROJECT_READY__ === id, projectId, { timeout: 90_000 });
  const panel = page.locator('#panel-sim-control .cfd-island [data-run-control="1"]');
  const folder = page.locator(`#left-tree [data-w17-sim-id="${simulationId}"] li[data-w27-sim-control="1"]`).first();
  await folder.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await folder.evaluate((el) => el.classList.contains('expanded')))) {
    await folder.locator(':scope > .tree-row .tw').click();
  }
  await page.locator(`#left-tree [data-w27-run="${runId}"] > .tree-row .tl`).first().click();
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    (rid) => document.querySelector('#panel-sim-control [data-run-control="1"]')?.getAttribute('data-run-id') === rid,
    runId,
    { timeout: 30_000 },
  );
  return panel;
}

/** The plugin-case records a server on `projectsRoot` keeps (its store file), or []. */
export function foamRecords(projectsRoot, webRoot = WEB_ROOT) {
  try {
    const doc = JSON.parse(readFileSync(foamStoreFileFor(projectsRoot, webRoot), 'utf8'));
    return Array.isArray(doc.records) ? doc.records : [];
  } catch {
    return [];
  }
}

/** End the relay of every case in the server's store (relays outlive their server): tools/foam_relay_ctl.py kill. */
export function killFoamRelays(projectsRoot, webRoot = WEB_ROOT) {
  const out = [];
  for (const rec of foamRecords(projectsRoot, webRoot)) {
    if (!rec || !/^fc-[a-z0-9]{6,12}-[0-9a-f]{6}$/.test(String(rec.id))) continue;
    const r = spawnSync(venvPython(), ['tools/foam_relay_ctl.py', 'kill', '--job-id', rec.id], {
      cwd: PY_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    out.push(`${rec.id}: ${String(r.stdout || r.stderr || '').trim()}`);
  }
  return out;
}

/** Whether the relay of a case is alive (tools/foam_relay_ctl.py alive), and its pids. */
export function foamRelayAlive(jobId) {
  const r = spawnSync(venvPython(), ['tools/foam_relay_ctl.py', 'alive', '--job-id', jobId], {
    cwd: PY_DIR,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  try {
    return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop());
  } catch {
    return { ok: false, alive: false, pids: [] };
  }
}

/**
 * After a test: end every WSL process under its own case root and remove the root.
 * Only a root of the form /tmp/magnusim-e2e-<name>-<pid>/cases (a test's own) is touched.
 */
export function removeTestWslRoot(wslRoot) {
  const m = /^(\/tmp\/magnusim-e2e-[a-z0-9-]+-\d+)\/cases$/.exec(String(wslRoot));
  if (!m) throw new Error(`not a test WSL root: ${wslRoot}`);
  try {
    killWslProcessesUnder(wslRoot);
  } catch (e) {
    console.warn(`[e2e] WSL processes under ${wslRoot} not listed: ${e.message}`);
  }
  wslBash('rm -rf -- "$1"', [m[1]], 120_000);
}
