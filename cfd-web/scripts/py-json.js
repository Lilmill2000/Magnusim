// @ts-check
/**
 * Spawn a Python CLI that prints one JSON document on stdout.
 * Used by Phase 1 Step 9 project_cli routing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { PYTHON, pyTool } from './python-env.js';

/** @type {null | ((method: string, params: unknown, timeoutMs?: number) => Promise<unknown>)} */
let workerCall = null;

/** Attach the long-lived worker so writes skip per-request project_cli spawns. */
export function attachWorkerBridge(fn) {
  workerCall = typeof fn === 'function' ? fn : null;
}

function viaWorker(method, params, timeoutMs) {
  if (!workerCall) return null;
  return workerCall(method, params, timeoutMs);
}

/** @param {string} method
 *  @param {unknown} [params]
 *  @param {number} [timeoutMs]
 *  @returns {Promise<unknown>|null} */
export function callWorker(method, params = {}, timeoutMs) {
  return viaWorker(method, params, timeoutMs);
}

function forbidProjectCli(scriptName) {
  if (process.env.CFDDESK_FORBID_PROJECT_CLI === '1' && scriptName === 'project_cli.py') {
    throw new Error('GET-no-spawn: project_cli forbidden');
  }
}

/**
 * @param {string} scriptName e.g. 'project_cli.py'
 * @param {string[]} args
 * @param {object|string|null} [stdinObj]
 * @returns {Promise<any>}
 */
export function pyJson(scriptName, args, stdinObj = null) {
  forbidProjectCli(scriptName);
  if (workerCall && scriptName === 'project_cli.py') {
    const mapped = mapProjectCliToRpc(args, stdinObj);
    if (mapped) return workerCall(mapped[0], mapped[1]);
  }
  const script = pyTool(scriptName);
  const argv = [script, ...args];
  const stdin =
    stdinObj == null
      ? null
      : typeof stdinObj === 'string'
        ? stdinObj
        : JSON.stringify(stdinObj);
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, argv, {
      windowsHide: true,
      stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr?.on('data', (c) => {
      err += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (!line) {
        reject(new Error(`pyJson empty stdout (code=${code}): ${err.slice(0, 500)}`));
        return;
      }
      try {
        const doc = JSON.parse(line);
        if (code && code !== 0 && doc && doc.ok === false) {
          resolve(doc);
          return;
        }
        if (code && code !== 0) {
          reject(new Error(`pyJson exit ${code}: ${err.slice(0, 500) || line}`));
          return;
        }
        resolve(doc);
      } catch (e) {
        reject(new Error(`pyJson parse fail: ${line.slice(0, 300)}; stderr=${err.slice(0, 300)}`));
      }
    });
    if (stdin != null && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}


function mapProjectCliToRpc(args, stdinObj) {
  const cmd = args[0];
  const dirIdx = args.indexOf('--project-dir');
  const projectDir = dirIdx >= 0 ? args[dirIdx + 1] : '';
  const simId = args.includes('--sim-id') ? args[args.indexOf('--sim-id') + 1] : '';
  const rel = args.includes('--rel') ? args[args.indexOf('--rel') + 1] : '';
  const runId = args.includes('--run-id') ? args[args.indexOf('--run-id') + 1] : '';
  const stamp = args.includes('--stamp-project');
  const body = stdinObj && typeof stdinObj === 'object' ? stdinObj : {};
  const table = {
    'set-materials': ['materials.set', { project_id: '', project_dir: projectDir, body, sim_id: simId }],
    'set-bcs': ['bcs.set', { project_dir: projectDir, body, sim_id: simId }],
    'set-mesh-settings': ['mesh.set', { project_dir: projectDir, body, sim_id: simId }],
    'set-refinements': ['refinements.set', { project_dir: projectDir, body, sim_id: simId }],
    'set-result-controls': ['result_controls.set', { project_dir: projectDir, body, sim_id: simId }],
    'set-sim-control': ['sim_control.set', { project_dir: projectDir, body, sim_id: simId }],
    'run-upsert': ['runs.upsert', { project_dir: projectDir, body, run_id: runId, sim_id: simId, stamp_project: stamp }],
    'run-delete': ['runs.delete', { project_dir: projectDir, run_id: runId, sim_id: simId }],
    'mesh-result': ['mesh.result.persist', { project_dir: projectDir, body, sim_id: simId }],
    'write-project': ['project.write_project', { project_dir: projectDir, doc: body }],
    'write-json': ['project.write_json', { project_dir: projectDir, rel, doc: body, sim_id: simId }],
    'save-catalog': ['runs.catalog.set', { project_dir: projectDir, body, sim_id: simId }],
    'write-simulation': ['project.write_simulation', { project_dir: projectDir, doc: body, sim_id: simId }],
    'save-sim-catalog': ['project.save_sim_catalog', { project_dir: projectDir, doc: body, sim_id: simId }],
  };
  return table[cmd] || null;
}

export function pyJsonSync(scriptName, args, stdinObj = null) {
  forbidProjectCli(scriptName);
  const script = pyTool(scriptName);
  const argv = [script, ...args];
  const stdin =
    stdinObj == null
      ? undefined
      : typeof stdinObj === 'string'
        ? stdinObj
        : JSON.stringify(stdinObj);
  const r = spawnSync(PYTHON, argv, {
    windowsHide: true,
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  const out = (r.stdout || '').trim();
  const line = out.split(/\r?\n/).filter(Boolean).pop() || '';
  if (!line) {
    throw new Error(
      'pyJsonSync empty stdout (status=' + String(r.status) + '): ' + String(r.stderr || '').slice(0, 500),
    );
  }
  const doc = JSON.parse(line);
  if (r.status && r.status !== 0 && !(doc && doc.ok === false)) {
    throw new Error(
      'pyJsonSync exit ' + String(r.status) + ': ' + String(r.stderr || line).slice(0, 500),
    );
  }
  return doc;
}

/**
 * Shared Step 9 helper: atomically write project.json via project_cli.
 * @param {string} projectDirPath
 * @param {object} proj
 * @param {string} [simId]
 */
export function writeProjectCli(projectDirPath, proj, simId = '') {
  const w = viaWorker('project.write_project', {
    project_dir: projectDirPath,
    doc: proj,
    sim_id: String(simId || ''),
  });
  if (w) return w;
  return pyJsonSync(
    'project_cli.py',
    ['write-project', '--project-dir', projectDirPath, '--sim-id', String(simId || '')],
    proj,
  );
}

/**
 * Write active-study mirror simulation.json via project_cli.
 * @param {string} projectDirPath
 * @param {object} sim
 * @param {string} [simId]
 */
export function writeSimulationCli(projectDirPath, sim, simId = '') {
  const w = viaWorker('project.write_simulation', {
    project_dir: projectDirPath,
    doc: sim,
    sim_id: String(simId || (sim && sim.id) || ''),
  });
  if (w) return w;
  return pyJsonSync(
    'project_cli.py',
    [
      'write-simulation',
      '--project-dir',
      projectDirPath,
      '--sim-id',
      String(simId || (sim && sim.id) || ''),
    ],
    sim,
  );
}

/**
 * Write simulations.json (+ active mirror) via project_cli.
 * @param {string} projectDirPath
 * @param {object} catalog
 * @param {string} [simId]
 */
export function saveSimCatalogCli(projectDirPath, catalog, simId = '') {
  const w = viaWorker('project.save_sim_catalog', {
    project_dir: projectDirPath,
    doc: catalog,
    sim_id: String(simId || ''),
  });
  if (w) return w;
  return pyJsonSync(
    'project_cli.py',
    ['save-sim-catalog', '--project-dir', projectDirPath, '--sim-id', String(simId || '')],
    catalog,
  );
}

/**
 * Atomically write an allowlisted project-relative JSON file via project_cli.
 * @param {string} projectDirPath
 * @param {string} rel e.g. 'materials.json' or 'runs/catalog.json'
 * @param {object} doc
 * @param {string} [simId]
 */
export function writeJsonCli(projectDirPath, rel, doc, simId = '') {
  const w = viaWorker('project.write_json', {
    project_dir: projectDirPath,
    rel: String(rel),
    doc,
    sim_id: String(simId || ''),
  });
  if (w) return w;
  return pyJsonSync(
    'project_cli.py',
    [
      'write-json',
      '--project-dir',
      projectDirPath,
      '--rel',
      String(rel),
      '--sim-id',
      String(simId || ''),
    ],
    doc,
  );
}

