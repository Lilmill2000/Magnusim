// @ts-check
/**
 * The CAD edition's registry: what the worker would answer for registry.describe
 * and plugins.list with only CAD installed, from scripts/generated/cad-edition-registry.json
 * (npm run gen:cad-edition makes it with the Python worker; gen:cad-edition:check
 * keeps it current). CAD is the one plugin, always on: Settings > Plugins shows it
 * and has nothing to turn off.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_ROOT } from '../../python-env.js';

const PATH = join(WEB_ROOT, 'scripts', 'generated', 'cad-edition-registry.json');

/**
 * @type {{
 *   describe: Record<string, unknown>,
 *   plugins: Array<Record<string, any>>,
 *   kinds: Array<Record<string, any>>,
 *   schema_versions: Record<string, Record<string, number>>,
 * } | null}
 */
let cached = null;

function load() {
  if (!cached) cached = JSON.parse(readFileSync(PATH, 'utf8'));
  return /** @type {NonNullable<typeof cached>} */ (cached);
}

/** A fresh copy each time: callers may change what they get. */
export function registryDescribe() {
  return structuredClone(load().describe);
}

export function pluginsList() {
  return { ok: true, plugins: structuredClone(load().plugins) };
}

/** The manifest row of an installed plugin (plugins.list's row), or null. */
export function pluginRow(key) {
  const row = load().plugins.find((p) => p.key === String(key || ''));
  return row ? structuredClone(row) : null;
}

/** The study kinds a project can make (plugin_studies.list's kinds). */
export function cadEditionKinds() {
  return structuredClone(load().kinds);
}

/** A study kind's schema version from its plugin's manifest, or null. */
export function schemaVersion(plugin, kind) {
  const n = load().schema_versions?.[String(plugin)]?.[String(kind)];
  return typeof n === 'number' ? n : null;
}
