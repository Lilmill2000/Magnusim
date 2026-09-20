// @ts-check
/**
 * Machine prefs in ``magnusim-web/.magnusim-local.json`` (also reads ``.cfddesk-local.json``).
 * Merge-only writes so WSL paths are never wiped.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envGet, resolveLocalJsonPath } from './env-compat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(__dirname, '..');
export const DEFAULT_PORT = 8082;
export const DEFAULT_UNITS = 'Metric';

const LOCAL_JSON = resolveLocalJsonPath(WEB_ROOT);

let mem = null;

export function localJsonPath() {
  return LOCAL_JSON;
}

export function readLocalDoc() {
  if (mem) return { ...mem };
  if (!existsSync(LOCAL_JSON)) {
    mem = {};
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(LOCAL_JSON, 'utf8'));
    mem = data && typeof data === 'object' ? data : {};
  } catch {
    mem = {};
  }
  return { ...mem };
}

export function resetPrefsCache() {
  mem = null;
}

export function writeLocalDoc(partial) {
  const next = { ...readLocalDoc(), ...(partial || {}) };
  writeFileSync(LOCAL_JSON, JSON.stringify(next, null, 2) + '\n', 'utf8');
  mem = next;
  return { ...next };
}

export function clampPort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
  return n;
}

export function listenPort() {
  const saved = clampPort(readLocalDoc().port);
  if (saved != null) return saved;
  const env = clampPort(envGet('PORT'));
  if (env != null) return env;
  return DEFAULT_PORT;
}

export function defaultUnits() {
  return /imperial/i.test(String(readLocalDoc().units || '')) ? 'Imperial' : DEFAULT_UNITS;
}

export function defaultLengthUnit() {
  const raw = String(readLocalDoc().length_unit || '').toUpperCase();
  if (['MM', 'CM', 'M', 'INCH'].includes(raw)) return raw;
  return defaultUnits() === 'Imperial' ? 'INCH' : 'MM';
}

export function wizardCompleted() {
  return !!readLocalDoc().wizard_completed;
}

/** Fold a finished Materials / BC / Mesh / … folder when you leave it. Default on. */
export function collapseCompletedSections() {
  return readLocalDoc().collapse_completed_sections !== false;
}

export function hardwarePrefs() {
  const h = readLocalDoc().hardware;
  return h && typeof h === 'object' ? h : null;
}

export function publicPrefs() {
  const doc = readLocalDoc();
  return {
    ok: true,
    units: defaultUnits(),
    length_unit: defaultLengthUnit(),
    port: listenPort(),
    wizard_completed: !!doc.wizard_completed,
    collapse_completed_sections: collapseCompletedSections(),
    hardware: hardwarePrefs(),
    wsl_distro: doc.wsl_distro || null,
    wsl_case_root: doc.wsl_case_root || null,
  };
}
