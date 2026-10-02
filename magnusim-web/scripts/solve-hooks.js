// @ts-check
/**
 * Which solve hooks some plugin listens to (solve.prepare, solve.parse_line,
 * solve.stop), asked once at boot and again whenever the registry changes. The
 * answer is cached: no start or stop path makes an RPC for it. With nothing
 * listening a solve gets no hook arguments, so its relay loads no plugin code.
 */

const NAME_RE = /^solve\.[a-z][a-z_]{0,40}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** @returns {{ names: string[], at: number }} */
function state() {
  const key = Symbol.for('magnusim.solveHooks');
  const g = /** @type {any} */ (globalThis);
  if (!g[key]) g[key] = { names: [], at: 0 };
  return g[key];
}

/** @param {unknown} raw */
function cleanNames(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((n) => String(n || '')).filter((n) => NAME_RE.test(n)))].sort();
}

/**
 * Ask the worker (plugin lane) which solve hooks have listeners. A failure or
 * no answer means none.
 * @param {{ call: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown> } | null | undefined} worker
 * @returns {Promise<string[]>}
 */
export async function refreshSolveHooks(worker) {
  const s = state();
  try {
    const answer = /** @type {any} */ (worker ? await worker.call('solve_hooks.listening', {}, 30_000) : null);
    s.names = cleanNames(answer && answer.names);
  } catch {
    s.names = [];
  }
  s.at = Date.now();
  return s.names.slice();
}

/** The cached names (tests and plugin cases). */
export function solveHookNames() {
  return state().names.slice();
}

/** @param {string[] | null} names */
export function setSolveHookNamesForTests(names) {
  const s = state();
  s.names = cleanNames(names || []);
  s.at = Date.now();
}

/**
 * A core run's owner, `core:<project>/<study>`, or '' when an id is missing or not plain.
 * @param {unknown} projectId
 * @param {unknown} simulationId
 */
export function coreOwner(projectId, simulationId) {
  const p = String(projectId || '');
  const s = String(simulationId || '');
  return ID_RE.test(p) && ID_RE.test(s) ? `core:${p}/${s}` : '';
}

/**
 * run_solve.py's hook arguments: none when nothing listens.
 * @param {string} owner
 * @returns {string[]}
 */
export function hookArgs(owner) {
  const names = state().names;
  if (!names.length || !owner) return [];
  return ['--owner', owner, '--hooks', names.join(',')];
}

/**
 * stop_solve.py's arguments for solve.stop: only when a plugin listens to it.
 * Probes never get them.
 * @param {{ owner: string, app?: unknown, caseDir?: unknown, nProcs?: unknown }} opts
 * @returns {string[]}
 */
export function stopHookArgs({ owner, app, caseDir, nProcs }) {
  if (!owner || !state().names.includes('solve.stop')) return [];
  const out = ['--owner', owner, '--hooks', 'solve.stop'];
  if (app && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(app))) out.push('--app', String(app));
  if (caseDir) out.push('--case-dir', String(caseDir));
  const n = Number(nProcs);
  if (Number.isInteger(n) && n >= 1) out.push('--n-procs', String(n));
  return out;
}
