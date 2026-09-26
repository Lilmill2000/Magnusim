// Which browser tests can run on this PC. Everything runs by default, including real
// meshes and solves (MAGNUSIM_E2E_WSL) and the long ones (MAGNUSIM_E2E_HEAVY), when WSL
// with OpenFOAM is here. Where it is not (CI, a PC without Setup), those tests skip and
// say why. Set a flag to 0 to skip on purpose; set MAGNUSIM_E2E_WSL=1 to insist, and a
// missing toolchain then fails the run instead of skipping.
import { spawnSync } from 'node:child_process';

function flag(name) {
  const raw = process.env[`MAGNUSIM_${name}`] ?? process.env[`CFDDESK_${name}`];
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw).trim() === '1';
}

function openFoamInWsl() {
  if (process.platform !== 'win32') return false;
  const distro = process.env.MAGNUSIM_WSL_DISTRO || process.env.CFDDESK_WSL_DISTRO || 'Ubuntu-24.04';
  const r = spawnSync('wsl.exe', ['-d', distro, '--', 'openfoam2606', 'bash', '-c', 'command -v simpleFoam'], {
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  return r.status === 0 && /simpleFoam/.test(String(r.stdout || ''));
}

/**
 * Settle MAGNUSIM_E2E_WSL and MAGNUSIM_E2E_HEAVY to '1' or '0' once, in the runner, so the
 * workers (and every spec) read the same answer without probing WSL again.
 */
export function settleE2eToolchain() {
  // Workers load the config again: the runner already settled both flags.
  if (process.env.MAGNUSIM_E2E_SETTLED === '1') {
    return { wsl: flag('E2E_WSL') === true, heavy: flag('E2E_HEAVY') === true };
  }
  let wsl = flag('E2E_WSL');
  if (wsl !== false) {
    const found = openFoamInWsl();
    if (wsl === true && !found) {
      throw new Error('MAGNUSIM_E2E_WSL=1 but WSL with OpenFOAM (openfoam2606 simpleFoam) was not found.');
    }
    if (wsl === null && !found) {
      console.warn('[e2e] WSL with OpenFOAM not found: real mesh and solve tests will be skipped.');
    }
    wsl = found;
  }
  const heavyFlag = flag('E2E_HEAVY');
  const heavy = wsl && heavyFlag !== false;
  process.env.MAGNUSIM_E2E_WSL = wsl ? '1' : '0';
  process.env.MAGNUSIM_E2E_HEAVY = heavy ? '1' : '0';
  process.env.MAGNUSIM_E2E_SETTLED = '1';
  return { wsl, heavy };
}

/** Why a WSL test is skipped, for its skip reason. */
export const NO_WSL = 'Needs WSL with OpenFOAM (not found, or MAGNUSIM_E2E_WSL=0)';
export const NO_HEAVY = 'Needs WSL with OpenFOAM (not found, or MAGNUSIM_E2E_WSL=0 / MAGNUSIM_E2E_HEAVY=0)';
