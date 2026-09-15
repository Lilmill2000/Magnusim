// @ts-check
/**
 * Spawn a Python CLI that prints one JSON document on stdout.
 * Used by Phase 1 Step 9 project_cli routing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { PYTHON, pyTool } from './python-env.js';

/**
 * @param {string} scriptName e.g. 'project_cli.py'
 * @param {string[]} args
 * @param {object|string|null} [stdinObj]
 * @returns {Promise<any>}
 */
export function pyJson(scriptName, args, stdinObj = null) {
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
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
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


export function pyJsonSync(scriptName, args, stdinObj = null) {
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
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
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

