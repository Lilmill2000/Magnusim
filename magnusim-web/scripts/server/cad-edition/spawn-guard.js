// @ts-check
/**
 * Magnusim CAD starts no Python and no WSL: this makes that a rule, not a hope.
 *
 * installSpawnGuard() wraps node:child_process (spawn, spawnSync, execFile,
 * execFileSync, exec, execSync) so a call that would start Python (python, pythonw,
 * py, or any .py script) or WSL (wsl, wslg) throws instead, says so on stderr with
 * where it came from, and is kept in spawnTrips() for tests. Everything else the
 * edition starts goes through: PowerShell (the Assistant's DPAPI key store, job
 * objects), the coding agents a person installed, and Node itself (the MCP bridge).
 *
 * The CAD edition's server entry installs it first, before any module that imports
 * child_process: syncBuiltinESMExports() then hands the wrapped calls to every
 * `import { spawn } from 'node:child_process'` made after it.
 */
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const BLOCKED_EXE = /^(?:python[0-9.]*|pythonw|py|wsl|wslg)(?:\.exe)?$/i;
const PY_SCRIPT = /\.py[cw]?$/i;

/** @type {Array<{ call: string, file: string, args: string[], stack: string }>} */
const trips = [];
let installed = false;

function base(file) {
  const s = String(file || '').replace(/^["']|["']$/g, '');
  return s.split(/[\\/]/).pop() || '';
}

/** Why a program and its arguments are refused, or '' when they may run. */
export function blockedReason(file, args = []) {
  const name = base(file);
  if (BLOCKED_EXE.test(name)) return `${name} is not started in Magnusim CAD (no Python, no WSL)`;
  const script = (args || []).map(String).find((a) => PY_SCRIPT.test(a.replace(/^["']|["']$/g, '')));
  if (script) return `a Python script (${base(script)}) is not run in Magnusim CAD`;
  return '';
}

/** A shell command line: its program and the rest, split on spaces (quotes kept whole). */
function splitCommand(command) {
  const parts = String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return { file: parts[0] || '', args: parts.slice(1) };
}

function refuse(call, file, args) {
  const why = blockedReason(file, args);
  if (!why) return;
  const err = new Error(why);
  err.name = 'CadEditionSpawnRefused';
  trips.push({ call, file: String(file), args: (args || []).map(String), stack: String(err.stack || '') });
  console.error(`[cad-edition] refused ${call}(${String(file)}): ${why}\n${err.stack}`);
  throw err;
}

function wrap(name, check) {
  const orig = /** @type {any} */ (cp)[name];
  if (typeof orig !== 'function' || orig.__cadEditionGuard) return;
  const wrapped = function (/** @type {any[]} */ ...a) {
    check(a);
    return orig.apply(this, a);
  };
  // exec and execFile carry util.promisify.custom: keep it, and every other property.
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
  Object.defineProperty(wrapped, '__cadEditionGuard', { value: true });
  /** @type {any} */ (cp)[name] = wrapped;
}

const fileArgs = (name) => (a) => refuse(name, a[0], Array.isArray(a[1]) ? a[1] : []);
const commandLine = (name) => (a) => {
  const { file, args } = splitCommand(a[0]);
  refuse(name, file, args);
};

export function installSpawnGuard() {
  if (installed) return;
  installed = true;
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) wrap(name, fileArgs(name));
  for (const name of ['exec', 'execSync']) wrap(name, commandLine(name));
  syncBuiltinESMExports();
}

/** What was refused so far (tests read it). */
export function spawnTrips() {
  return trips.slice();
}
