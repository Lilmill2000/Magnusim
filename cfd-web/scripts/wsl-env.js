/**
 * WSL distro + case root for this machine.
 *
 * Setup.bat writes ``.cfddesk-local.json`` next to the web app. Until then we
 * read CFDDESK_WSL_* env vars and, if needed, ask WSL for $HOME/cases so a
 * clone does not write under a previous machine's home.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(__dirname, '..');
export const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04';

const LOCAL_JSON = process.env.CFDDESK_LOCAL_JSON
  ? resolve(process.env.CFDDESK_LOCAL_JSON)
  : join(WEB_ROOT, '.cfddesk-local.json');

let cached = null;

function readLocal() {
  if (!existsSync(LOCAL_JSON)) return {};
  try {
    const data = JSON.parse(readFileSync(LOCAL_JSON, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function probeWslHome(distro) {
  try {
    const r = spawnSync('wsl', ['-d', distro, '--', 'printenv', 'HOME'], {
      encoding: 'utf8',
      timeout: 45000,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const home = lines[lines.length - 1] || '';
    return home.startsWith('/') && home !== '/' ? home : null;
  } catch {
    return null;
  }
}

export function wslSettings() {
  if (cached) return cached;
  const local = readLocal();
  const distro =
    String(process.env.CFDDESK_WSL_DISTRO || '').trim() ||
    String(local.wsl_distro || '').trim() ||
    DEFAULT_WSL_DISTRO;
  let root =
    String(process.env.CFDDESK_WSL_CASE_ROOT || '').trim() ||
    String(local.wsl_case_root || '').trim();
  if (!root) {
    const home = probeWslHome(distro);
    if (home) root = home.replace(/\/+$/, '') + '/cases';
  }
  if (!root) root = '/home/cfddesk/cases';
  cached = { wsl_distro: distro, wsl_case_root: root.replace(/\/+$/, '') };
  return cached;
}

/** Forget a cached probe (Setup just wrote ``.cfddesk-local.json``). */
export function resetWslSettingsCache() {
  cached = null;
}

export function wslDistro() {
  return wslSettings().wsl_distro;
}

export function wslCaseRoot() {
  return wslSettings().wsl_case_root;
}

/** Absolute ext4 path ``<root>/<id>`` when ``id`` is a single segment. */
export function wslCasePath(idOrPath) {
  const raw = String(idOrPath || '').trim();
  if (!raw) return wslCaseRoot();
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '');
  return `${wslCaseRoot()}/${raw}`;
}

let toolchainChecked = false;

/**
 * Once per Vite process: warn if .cfddesk-local.json lacks OpenFOAM/cfMesh
 * versions or live `foamVersion` disagrees.
 */
export function verifyWslToolchain() {
  if (toolchainChecked) return;
  toolchainChecked = true;
  const local = readLocal();
  const distro = wslDistro();
  const recordedOf = String(local.openfoam_version || '').trim();
  const recordedCf = String(local.cfmesh_version || '').trim();
  if (!recordedOf) {
    console.warn('[cfddesk] .cfddesk-local.json missing openfoam_version — re-run Setup.bat to pin toolchain');
  }
  if (!recordedCf && String(local.cartesianMesh || '') === 'yes') {
    console.warn('[cfddesk] .cfddesk-local.json missing cfmesh_version');
  }
  try {
    const r = spawnSync(
      'wsl',
      ['-d', distro, '--', 'openfoam2606', 'bash', '-c', 'foamVersion'],
      { encoding: 'utf8', timeout: 60000, windowsHide: true },
    );
    if (r.status !== 0) {
      console.warn('[cfddesk] could not probe foamVersion in WSL distro', distro);
      return;
    }
    const live = String(r.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (recordedOf && live && recordedOf !== live && !live.includes(recordedOf) && !recordedOf.includes(live)) {
      console.warn('[cfddesk] OpenFOAM version drift: local json has ' + recordedOf + ' but WSL reports ' + live);
    }
  } catch (err) {
    console.warn('[cfddesk] verifyWslToolchain failed', err && err.message);
  }
}