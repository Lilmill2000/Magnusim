// @ts-check
/**
 * How many MPI ranks this PC gives a run (core solves and plugin cases). Its own
 * module so the step-list runner (foam-runner.js) and the core solve
 * (w27-solve.js, core-solve.js) read it without importing each other.
 */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { hardwarePrefs } from './prefs.js';

/**
 * Physical core count (not SMT threads). One MPI rank per physical core is the
 * fastest configuration measured on this box (Ball Test, 264k cells, 120 fixed
 * steps): 16 ranks 140 ms/step, 15 → 144, 14 → 148, 12 → 163, 8 → 213, and
 * 32 ranks on hyperthreads 2542 ms/step. Binding flags, MPI transport flags and
 * renumberMesh changed nothing, so only the rank count is tuned here.
 * Resolved once, asynchronously, from CIM; `hardwareRankCap` falls back to the
 * logical count if it has not answered yet.
 */
let PHYSICAL_CORES = 0;
function detectPhysicalCores() {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    if (child.stdout) child.stdout.on('data', (d) => { out += String(d); });
    child.on('close', () => {
      const n = Number(String(out).trim());
      if (Number.isFinite(n) && n >= 1) PHYSICAL_CORES = Math.floor(n);
    });
    child.on('error', () => {});
  } catch {
    /* keep fallback */
  }
}
detectPhysicalCores();

/**
 * The most MPI ranks this PC gives a run: one per physical core (never two on one
 * core's hyperthreads), capped by Settings → Hardware. WSL's own slot count is not
 * asked here (the relay clamps by it).
 */
export function hardwareRankCap() {
  const logical = Math.max(1, (cpus() || []).length);
  // One rank per physical core. Never oversubscribe hyperthreads: OpenMPI
  // ranks busy-poll, and two ranks on one core ran ~18x slower in testing.
  let nProcs;
  if (PHYSICAL_CORES >= 1) nProcs = Math.max(2, Math.min(PHYSICAL_CORES, logical));
  else nProcs = Math.max(2, logical >= 8 ? Math.floor(logical / 2) : logical);
  const hw = hardwarePrefs();
  const cap = hw && Number(hw.n_procs);
  if (Number.isFinite(cap) && cap >= 1) nProcs = Math.min(nProcs, Math.floor(cap));
  return nProcs;
}

/** The WSL MPI slot count Settings → Hardware saved, or null. */
export function savedWslSlots() {
  const hw = hardwarePrefs();
  const n = hw && Number(hw.wsl_mpi_slots);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * The most ranks a run gets on this PC: hardwareRankCap at most the WSL MPI slots
 * Settings saved. The Run panel's Cores choice offers 1 up to this.
 */
export function runRankCap() {
  let n = hardwareRankCap();
  const slots = savedWslSlots();
  if (slots) n = Math.min(n, slots);
  return Math.max(1, n);
}

/**
 * A run's Cores setting (run.cores) as a whole number of cores, or null for Auto
 * (unset, blank, "auto", 0 or anything that is not a positive number).
 * @param {unknown} v
 */
export function runCoresSetting(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 4096) : null;
}
