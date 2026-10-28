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

function readLocalDocFromDisk() {
  if (!existsSync(LOCAL_JSON)) return {};
  try {
    const data = JSON.parse(readFileSync(LOCAL_JSON, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function writeLocalDoc(partial) {
  // Merge onto the file as it is now, not the cached copy: the Python worker is
  // the only writer of the plugin on/off lists (plugins.disabled, plugins.enabled),
  // and a stale cache would write an old list back (a plugin turned off comes back
  // on after a units save). Node never writes them, even if a caller passes them.
  const own = { ...(partial || {}) };
  delete own.plugins;
  delete own['plugins.disabled'];
  delete own['plugins.enabled'];
  const next = { ...readLocalDocFromDisk(), ...own };
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

/** The app's commands whose keys the person may change (src/keybinds/appKeys.ts CHANGEABLE_APP_KEYS). */
export const APP_KEYBIND_IDS = ['app.assistant'];
/** A combo's shape: modifiers in the order Ctrl, Alt, Shift, Meta, then a key code (the page checks the code). */
const COMBO_SHAPE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[A-Za-z][A-Za-z0-9]{0,19}$/;

/**
 * The person's keys for the app's own commands (Settings → Keybinds): { "<id>": [combo, ...] } with
 * only the changeable ids and at most 4 combo-shaped strings each, or null when `value` is not
 * that shape. The page reads them again with its own rules (appKeys.ts readAppKeybinds).
 */
export function cleanAppKeybinds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [id, keys] of Object.entries(value)) {
    if (!APP_KEYBIND_IDS.includes(id)) return null;
    if (!Array.isArray(keys) || keys.length > 4 || !keys.every((k) => typeof k === 'string' && COMBO_SHAPE.test(k))) return null;
    out[id] = [...keys];
  }
  return out;
}

/** The person's keys for the app's own commands as stored ({} when none, or when the file has junk). */
export function appKeybinds() {
  return cleanAppKeybinds(readLocalDoc().keybinds) || {};
}

/** Settings → Appearance: what it offers (src/theme/appearance.ts keeps the same lists). */
export const THEMES = ['light', 'dark', 'system'];
export const TEXT_SCALES = [0.9, 1, 1.15, 1.3];
export const ICON_SCALES = [0.85, 1, 1.25, 1.5];

/** The person's look as stored: each field one Settings offers, else its default (light, 1, 1). */
export function appearancePrefs() {
  const doc = readLocalDoc();
  return {
    theme: THEMES.includes(doc.theme) ? doc.theme : 'light',
    text_scale: TEXT_SCALES.includes(doc.text_scale) ? doc.text_scale : 1,
    icon_scale: ICON_SCALES.includes(doc.icon_scale) ? doc.icon_scale : 1,
  };
}

/**
 * The page as served, with the stored look on its <html> (data-look, JSON): the pre-paint script in
 * index.html and cad.html shows it before the first paint on any origin. The page's own storage
 * can't: Magnusim CAD's server takes a new port at every start, and with it a new, empty storage.
 */
export function stampAppearance(html) {
  const look = JSON.stringify(appearancePrefs()).replace(/"/g, '&quot;');
  return String(html).replace(/<html\b/i, `<html data-look="${look}"`);
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
    keybinds: appKeybinds(),
    ...appearancePrefs(),
    wsl_distro: doc.wsl_distro || null,
    wsl_case_root: doc.wsl_case_root || null,
  };
}
