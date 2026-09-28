/**
 * Python filter/export processes. Case-field middleware calls these
 * instead of spawning interpreters itself.
 */
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { PYTHON } from './python-env.js';

// Filter tools still reading a case folder, so deleting that folder can stop them
// first: on Windows a file a process has open cannot be removed.
const caseChildren = new Map();

function caseKey(dir) {
  const k = resolve(String(dir)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? k.toLowerCase() : k;
}

function trackCaseChild(caseDir, child) {
  const key = caseKey(caseDir);
  let set = caseChildren.get(key);
  if (!set) caseChildren.set(key, (set = new Set()));
  set.add(child);
  child.on('close', () => {
    set.delete(child);
    if (!set.size) caseChildren.delete(key);
  });
}

/** Kill filter tools reading `dir` (or a folder inside it) and wait until they exit. */
export async function stopFilterToolsFor(dir, { waitMs = 10000 } = {}) {
  if (!dir) return 0;
  const root = caseKey(dir);
  const waits = [];
  for (const [key, set] of caseChildren) {
    if (key !== root && !key.startsWith(root + sep)) continue;
    for (const child of set) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      waits.push(new Promise((done) => {
        const timer = setTimeout(done, waitMs);
        child.once('close', () => { clearTimeout(timer); done(); });
      }));
      try { child.kill(); } catch { /* already exited */ }
    }
  }
  await Promise.all(waits);
  return waits.length;
}

export function spawnFilter(args, opts = {}) {
  return spawn(PYTHON, args, { windowsHide: true, ...opts });
}

/**
 * Run a filter tool to completion without blocking the server's event loop.
 * Resolves { status, stdout, stderr } (status null when killed on timeout).
 */
export function runFilterToolAsync(args, { timeout = 180000, caseDir = null, ...opts } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(PYTHON, args, { windowsHide: true, ...opts });
    if (caseDir) trackCaseChild(caseDir, child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += `\n[timeout after ${timeout} ms]`;
      try { child.kill(); } catch { /* already exited */ }
    }, timeout);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveP({ status: null, stdout, stderr: `${stderr}\n${err && err.message ? err.message : err}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ status: code, stdout, stderr });
    });
  });
}
