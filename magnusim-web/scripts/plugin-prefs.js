// @ts-check
/**
 * A plugin's own preferences for this user (host API 1.7): small JSON values a
 * plugin keeps across every project, such as a toolbar layout or its last-used
 * options. One file per plugin, `<prefs dir>/<plugin>.json` = {key: value}, beside
 * the machine prefs (.magnusim-local.json, or the file MAGNUSIM_LOCAL_JSON names,
 * as each e2e server does), or in MAGNUSIM_PLUGIN_PREFS_DIR. Only Node writes them
 * (atomically); a plugin reaches only its own file, through the bridge's scope.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { envGet, resolveLocalJsonPath } from './env-compat.js';
import { writeJsonAtomic } from './project-layout.js';

/** The most one plugin keeps, as JSON text. */
export const PREFS_MAX_BYTES = 64 * 1024;
/** A pref's name. */
export const PREF_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLUGIN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A refusal with a code the bridge hands the page. */
export class PluginPrefsError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Where the prefs files are. @param {string} webRoot */
export function pluginPrefsDir(webRoot) {
  const override = envGet('PLUGIN_PREFS_DIR');
  if (override) return resolve(override);
  return join(dirname(resolveLocalJsonPath(webRoot)), '.magnusim-plugin-prefs');
}

/** @param {string} webRoot @param {string} plugin */
function fileOf(webRoot, plugin) {
  if (!PLUGIN_RE.test(String(plugin))) throw new PluginPrefsError('invalid_plugin', 'not a plugin key');
  return join(pluginPrefsDir(webRoot), `${plugin}.json`);
}

/** @param {unknown} key */
function checkKey(key) {
  if (typeof key !== 'string' || !PREF_KEY_RE.test(key)) {
    throw new PluginPrefsError('invalid_key', 'A pref name is 1 to 64 of a-z, 0-9, ".", "_" and "-", starting with a letter or digit');
  }
  return key;
}

/** Every pref of a plugin ({} when it has none, or its file cannot be read). @param {string} webRoot @param {string} plugin */
export function readPluginPrefs(webRoot, plugin) {
  const file = fileOf(webRoot, plugin);
  if (!existsSync(file)) return {};
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  } catch (e) {
    console.warn(`[CFD plugin prefs] ${plugin}: its prefs file could not be read; it starts empty`, e);
    return {};
  }
}

/** A pref's value, null when it has none. @param {string} webRoot @param {string} plugin @param {unknown} key */
export function getPluginPref(webRoot, plugin, key) {
  const k = checkKey(key);
  const all = readPluginPrefs(webRoot, plugin);
  return Object.prototype.hasOwnProperty.call(all, k) ? all[k] : null;
}

/**
 * Set a pref to a JSON value (null removes it). Refused past PREFS_MAX_BYTES for the
 * plugin's whole file, which is then left as it was.
 * @param {string} webRoot @param {string} plugin @param {unknown} key @param {unknown} value
 */
export function setPluginPref(webRoot, plugin, key, value) {
  const k = checkKey(key);
  if (value === null || value === undefined) return removePluginPref(webRoot, plugin, k);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new PluginPrefsError('invalid_value', 'A pref is a JSON value');
  const all = { ...readPluginPrefs(webRoot, plugin), [k]: JSON.parse(text) };
  const size = Buffer.byteLength(JSON.stringify(all), 'utf8');
  if (size > PREFS_MAX_BYTES) {
    throw new PluginPrefsError('too_large', `A plugin keeps at most ${PREFS_MAX_BYTES / 1024} KB of prefs (this would be ${Math.ceil(size / 1024)} KB)`, 413);
  }
  writeJsonAtomic(fileOf(webRoot, plugin), all);
}

/** Remove a pref (nothing when it has none). @param {string} webRoot @param {string} plugin @param {unknown} key */
export function removePluginPref(webRoot, plugin, key) {
  const k = checkKey(key);
  const all = readPluginPrefs(webRoot, plugin);
  if (!Object.prototype.hasOwnProperty.call(all, k)) return;
  delete all[k];
  const file = fileOf(webRoot, plugin);
  if (Object.keys(all).length) writeJsonAtomic(file, all);
  else rmSync(file, { force: true });
}
