// @ts-check
/**
 * One-shot PC check used by the setup wizard.
 * Writes ``hardware`` into ``.magnusim-local.json (or legacy .cfddesk-local.json)`` so solves pick n_procs from it.
 */
import { cpus, totalmem } from 'node:os';
import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { WEB_ROOT, writeLocalDoc } from './prefs.js';
import { wslDistro } from './wsl-env.js';

/** Open MPI slots as WSL reports them (cores, not hyperthreads). Hybrid Intel
 *  CPUs often show fewer slots in WSL than Windows Win32_Processor.NumberOfCores. */
export function probeWslMpiSlots(distro) {
  const name = String(distro || '').trim();
  if (!name) return 0;
  try {
    const r = spawnSync(
      'wsl',
      [
        '-d',
        name,
        '--',
        'bash',
        '-lc',
        "lscpu 2>/dev/null | awk -F: '/^Core\\(s\\) per socket/{gsub(/[ \\t]/,\"\",$2); c=$2} /^Socket\\(s\\)/{gsub(/[ \\t]/,\"\",$2); s=$2} END{v=(c+0)*(s+0); print v+0}'",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );
    const n = Number(String(r.stdout || '').trim().split(/\s+/).pop());
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  } catch {
    /* keep 0 */
  }
  return 0;
}

function physicalCoreCount() {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      );
      const n = Number(String(r.stdout || '').trim());
      if (Number.isFinite(n) && n >= 1) return Math.floor(n);
    } catch {
      /* fall through */
    }
  }
  const logical = Math.max(1, (cpus() || []).length);
  return logical >= 8 ? Math.floor(logical / 2) : logical;
}

function diskFreeGb() {
  try {
    const st = statfsSync(WEB_ROOT);
    if (st && st.bavail > 0 && st.bsize > 0) return Math.round((st.bavail * st.bsize) / 1e9);
  } catch {
    /* Node < 18.15 or non-statfs filesystem */
  }
  return null;
}

function probeOpenFoam(distro) {
  try {
    const r = spawnSync(
      'wsl',
      ['-d', distro, '--', 'openfoam2606', 'bash', '-c', 'simpleFoam -help'],
      { encoding: 'utf8', windowsHide: true, timeout: 90000 },
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

export function computeProfile({ physical, logical, ram_gb: ramGb, wsl_slots: wslSlots }) {
  let n = physical >= 1 ? physical : logical >= 8 ? Math.floor(logical / 2) : logical;
  const reserve = n >= 4 ? 1 : 0;
  n = Math.max(1, n - reserve);
  const ramCap = Math.max(1, Math.floor(Number(ramGb) / 3.5) || 1);
  n = Math.min(n, ramCap);
  const slots = Number(wslSlots);
  if (Number.isFinite(slots) && slots >= 1 && n > slots) {
    n = Math.floor(slots);
  }

  let profile = 'standard';
  if (ramGb < 8 || physical <= 2) profile = 'light';
  else if (ramGb >= 24 && physical >= 12) profile = 'workstation';

  const notes = [];
  if (profile === 'light') {
    notes.push('This PC is on the small side. Keep meshes under a few hundred thousand cells when you can.');
  } else if (profile === 'workstation') {
    notes.push('Workstation-class machine. Larger meshes and more MPI ranks are fine.');
  }
  if (reserve) {
    notes.push('Leaving one core free so the viewer stays responsive while a solve runs.');
  }
  if (Number.isFinite(slots) && slots >= 1) {
    notes.push('Open MPI in WSL reports ' + Math.floor(slots) + ' core slots.');
  }
  notes.push('Solves will use ' + n + ' MPI rank' + (n === 1 ? '' : 's') + '.');
  if (ramGb < 8) {
    notes.push('Under 8 GB RAM: close other apps before meshing or solving.');
  }
  return { profile, n_procs: n, reserve_cores: reserve, notes };
}

export function runHardwareCheck() {
  const logical = Math.max(1, (cpus() || []).length);
  const physical = physicalCoreCount();
  const ram_gb = Math.round((totalmem() / 1e9) * 10) / 10;
  const disk_free_gb = diskFreeGb();
  const distro = wslDistro();
  const openfoam_ok = probeOpenFoam(distro);
  const wsl_slots = probeWslMpiSlots(distro);
  const tuned = computeProfile({ physical, logical, ram_gb, wsl_slots });
  const hardware = {
    checked_at: new Date().toISOString(),
    logical_cpus: logical,
    physical_cores: physical,
    ram_gb,
    disk_free_gb,
    wsl_distro: distro,
    wsl_mpi_slots: wsl_slots || null,
    openfoam_ok,
    ...tuned,
  };
  writeLocalDoc({ hardware });
  return hardware;
}
