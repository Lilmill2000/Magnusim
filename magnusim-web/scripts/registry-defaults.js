// @ts-check
/**
 * Phase 2 land13 — thin dual-defaults consumer.
 * Reads the live registry (worker registry.describe, set by the API server at
 * boot and after every plugin change). Until that arrives, and for offline
 * tooling, it falls back to the committed scripts/generated/registry.json,
 * which lists what ships (core builtins + bundled plugins). User plugin keys
 * therefore exist only in the live doc.
 *
 * Study defaults, algorithm labels and run defaults are the analysis's own
 * (the analysis contract publishes them in its registry row). Nothing here
 * throws when an analysis is missing: a missing required plugin is reported
 * by requiredPluginError() instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_JSON_PATH = join(__dirname, 'generated', 'registry.json');

/** Mesher keys used as W20 advanced.mesh_engine (not algorithm-only backends). */
// Hex-dominant (snappyHexMesh) is a product engine too; leaving it out coerced a
// saved Hex-dominant pick back to Standard.
const MESH_ENGINE_PRODUCT_KEYS = Object.freeze(['standard', 'cfmesh', 'snappy_hexdominant']);

let _cache = null;
/** Live registry.describe doc from the worker (builtins + loaded plugins). */
let _live = null;

/**
 * Load committed registry dump (cached). Throws if missing/invalid.
 * @returns {Record<string, unknown>}
 */
export function loadCommittedRegistry() {
  if (_cache) return _cache;
  if (!existsSync(REGISTRY_JSON_PATH)) {
    throw new Error(`missing committed registry.json: ${REGISTRY_JSON_PATH}`);
  }
  const raw = JSON.parse(readFileSync(REGISTRY_JSON_PATH, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('committed registry.json must be a JSON object');
  }
  _cache = raw;
  return _cache;
}

/** Test helper: clear module cache so a swapped file is re-read. */
export function resetRegistryCache() {
  _cache = null;
  _live = null;
  _syncMeshEngines();
}

/**
 * Install the live registry (worker registry.describe). Called by the API
 * server at boot and after registry.reload / plugins.enable / plugins.disable.
 * @param {unknown} doc
 * @returns {boolean} true when the doc was accepted
 */
export function setLiveRegistry(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (!Array.isArray(d.mesher) || !Array.isArray(d.analysis)) return false;
  _live = d;
  _syncMeshEngines();
  return true;
}

/** True once the live registry has been installed. */
export function liveRegistryLoaded() {
  return _live !== null;
}

/**
 * The required bundled plugins that did not load (registry.describe
 * required_missing): [{ key, name, error, folder, log }].
 * @returns {Array<Record<string, string>>}
 */
export function requiredPluginsMissing() {
  const rows = _live && Array.isArray(_live.required_missing) ? _live.required_missing : [];
  return rows.filter((r) => r && typeof r === 'object');
}

/**
 * The blocking error while a required plugin is missing, else null:
 * "Incompressible Flow failed to load: <why>. Magnusim can't create or run
 * simulations. Details: <log>".
 * @returns {string | null}
 */
export function requiredPluginError() {
  const row = requiredPluginsMissing()[0];
  if (!row) return null;
  const log = row.log ? ` Details: ${row.log}` : '';
  return `${row.name || row.key} failed to load: ${row.error || 'unknown error'}. Magnusim can't create or run simulations.${log}`;
}

function _registryDoc() {
  return _live || loadCommittedRegistry();
}

function _rows(kind) {
  const doc = _registryDoc();
  const rows = doc[kind];
  return Array.isArray(rows) ? rows : [];
}

export function analysisEntries() {
  return _rows('analysis');
}

export function mesherEntries() {
  return _rows('mesher');
}

export function analysisKeys() {
  return analysisEntries()
    .map((r) => (r && r.key != null ? String(r.key) : ''))
    .filter(Boolean);
}

export function mesherKeys() {
  return mesherEntries()
    .map((r) => (r && r.key != null ? String(r.key) : ''))
    .filter(Boolean);
}

export function analysisByKey(key) {
  const want = String(key || '');
  return analysisEntries().find((r) => r && String(r.key) === want) || null;
}

function timeDependencyKey(td) {
  return /transient/i.test(String(td || '')) ? 'transient' : 'steady';
}

/**
 * The analysis a study gets when none is named: the required bundled plugin's
 * [default_analysis] (registry.describe default_analysis: { steady, transient,
 * aliases }), or null without it (the plugin did not load).
 * @returns {{ steady: string, transient?: string, aliases?: string[] } | null}
 */
export function defaultAnalysis() {
  const d = /** @type {any} */ (_registryDoc()).default_analysis;
  return d && typeof d === 'object' && typeof d.steady === 'string' && d.steady ? d : null;
}

/**
 * The default analysis's key at a time dependency ('' without one).
 * @param {string | null | undefined} [timeDependency]
 */
export function defaultAnalysisKey(timeDependency) {
  const d = defaultAnalysis();
  if (!d) return '';
  return timeDependencyKey(timeDependency) === 'transient' ? String(d.transient || d.steady) : String(d.steady);
}

/**
 * True for a name studies saved before analysis keys carry for the default
 * analysis (its [default_analysis] aliases).
 * @param {string | null | undefined} name
 */
export function isDefaultAnalysisAlias(name) {
  const raw = String(name || '').trim().toLowerCase();
  const d = defaultAnalysis();
  return !!raw && !!d && (d.aliases || []).some((a) => String(a).toLowerCase() === raw);
}

/**
 * The registered AnalysisType for an analysis family and a time dependency
 * (same rule as cfddesk.registry.analysis.analysis_key_for): the key itself
 * when it already has that time dependency, else its registered `_steady` ↔
 * `_transient` sibling, else the analysis of its family with that time
 * dependency when the family pairs one of each, else the key unchanged.
 * Blank, or a name the default analysis lists in its aliases (studies saved
 * before analysis keys), maps to the default analysis.
 * @param {string | null | undefined} key
 * @param {string | null | undefined} timeDependency
 */
export function analysisKeyFor(key, timeDependency) {
  const td = timeDependencyKey(timeDependency);
  const raw = String(key || '').trim();
  if (!raw || isDefaultAnalysisAlias(raw)) return defaultAnalysisKey(td);
  const row = analysisByKey(raw);
  if (row && String(row.time_dependency || '') === td) return raw;
  const m = raw.match(/^(.*)_(steady|transient)$/);
  if (m) {
    const sibling = `${m[1]}_${td}`;
    if (analysisByKey(sibling)) return sibling;
  }
  const family = row && row.family && row.family.key ? String(row.family.key) : '';
  if (family) {
    const members = analysisEntries().filter((r) => r && r.family && String(r.family.key) === family);
    const same = members.filter((r) => String(r.time_dependency || '') === String(row.time_dependency || ''));
    const other = members.filter((r) => String(r.time_dependency || '') === td);
    if (same.length === 1 && other.length === 1) return String(other[0].key);
  }
  return raw;
}

/** True when `key` (or its sibling) is registered for that time dependency. */
export function analysisSupportsTimeDependency(key, timeDependency) {
  const resolved = analysisKeyFor(key, timeDependency);
  const row = analysisByKey(resolved);
  return !!row && String(row.time_dependency || '') === timeDependencyKey(timeDependency);
}

/**
 * Run-control defaults of an analysis, from its registered control_schema
 * (built from incompressible_flow.transient STEADY_DEFAULTS / TRANSIENT_DEFAULTS,
 * the one copy). A null default means "calculate for me" (the auto time step).
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
export function controlDefaults(key) {
  const row = analysisByKey(key);
  const props =
    row && row.control_schema && row.control_schema.properties && typeof row.control_schema.properties === 'object'
      ? row.control_schema.properties
      : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    out[k] = p && typeof p === 'object' && 'default' in p ? p.default : null;
  }
  return out;
}

/**
 * The settings a new run of this analysis starts with: its contract's
 * run_defaults ({} when it is not installed). A fresh copy.
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
export function runDefaultsFor(key) {
  const row = analysisByKey(key);
  const d = row && row.run_defaults;
  return d && typeof d === 'object' ? { .../** @type {Record<string, unknown>} */ (d) } : {};
}

/** Steady run-control defaults ({ end_time, write_interval } in iterations) of the default analysis ({} if not installed). */
export function steadyDefaultsFromRegistry() {
  return Object.freeze(controlDefaults(defaultAnalysisKey('steady')));
}

/**
 * A new study's settings for an analysis: the record its contract publishes
 * (analysis_type, analysis, analysis_title, turbulence, time_dependency,
 * algorithm, …), or null when the analysis is not installed.
 * @param {string} key
 * @returns {Record<string, any> | null}
 */
export function studyDefaultsFor(key) {
  const row = analysisByKey(key);
  const d = row && row.study_defaults;
  return d && typeof d === 'object' ? /** @type {Record<string, any>} */ (d) : null;
}

/**
 * The algorithm label an analysis shows ("SIMPLE", "PIMPLE"): its contract's
 * algorithm_label ('' when it publishes none).
 * @param {string} key
 */
export function algorithmLabelFor(key) {
  const row = analysisByKey(key);
  if (!row) return '';
  return String(row.algorithm_label || '');
}

/**
 * The registered SolverApp whose OpenFOAM application is `app` (its key, label,
 * time_dependency, parallel and stop_strategy), or null when no loaded plugin
 * registers it. Plugin OpenFOAM cases may only run a registered solver.
 * @param {unknown} app
 * @returns {Record<string, any> | null}
 */
export function solverForApplication(app) {
  const want = String(app || '');
  if (!want) return null;
  const rows = _rows('solver');
  return rows.find((r) => r && String(r.application || r.key || '') === want) || null;
}

/**
 * The loaded plugin's row ({ key, name, version, … }) from the live registry, or
 * null when it is off, failed to load or the live registry is not loaded yet.
 * @param {unknown} key
 * @returns {Record<string, any> | null}
 */
export function pluginLoaded(key) {
  const want = String(key || '');
  if (!want || !_live || !Array.isArray(_live.plugins)) return null;
  return _live.plugins.find((p) => p && String(p.key) === want) || null;
}

/**
 * The boundary conditions the user can pick: the registered BC families
 * (registry kind bc_family; { key, label, record_type, aliases, defaults,
 * values, fields, ... }), from the plugins that register them.
 * @returns {Array<Record<string, any>>}
 */
export function bcFamilies() {
  return _rows('bc_family').filter((r) => r && typeof r === 'object' && r.record_type);
}

/** The bc_type a saved BC record of each family carries ("Velocity inlet", "Wall", ...). */
export function bcRecordTypes() {
  return bcFamilies().map((r) => String(r.record_type));
}

/** A bc_type compared without case or spaces ("pressure Outlet" = "Pressure outlet"). */
function _bcTypeText(raw) {
  return String(raw || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * The BC family whose record_type or one of its aliases is `type`, ignoring
 * case and spaces (the worker's bc_family_for rule), or null.
 * @param {unknown} type
 * @returns {Record<string, any> | null}
 */
export function bcFamilyFor(type) {
  const want = _bcTypeText(type);
  if (!want) return null;
  return (
    bcFamilies().find((f) =>
      [f.record_type, ...(Array.isArray(f.aliases) ? f.aliases : [])].some((n) => _bcTypeText(n) === want)
    ) || null
  );
}

/**
 * The bc_type a record is saved under: its family's record_type ("Pressure
 * outlet" is stored as "Pressure"), else the text as given (trimmed).
 * @param {unknown} raw
 */
export function canonicalBcType(raw) {
  const t = String(raw || '').trim();
  const fam = bcFamilyFor(t);
  return fam ? String(fam.record_type) : t;
}

/**
 * The registry docs to look a material model up in: the live one, then the
 * committed scripts/generated/registry.json (what ships), so a new material is
 * seeded from the bundled plugin's presets even before the live registry loads.
 * @returns {Array<Record<string, any>>}
 */
function _materialDocs() {
  /** @type {Array<Record<string, any>>} */
  const docs = [];
  if (_live) docs.push(_live);
  try {
    const committed = loadCommittedRegistry();
    if (!docs.includes(committed)) docs.push(committed);
  } catch {
    /* no committed registry: the live one only */
  }
  return docs;
}

/**
 * A material model's registry row ({ key, label, schema, library, record_keys,
 * record_constants, custom_preset }), or null. A blank key is the default
 * analysis's first material model. The live registry first, then the
 * committed one.
 * @param {unknown} [key]
 * @returns {Record<string, any> | null}
 */
export function materialModel(key) {
  for (const doc of _materialDocs()) {
    let want = String(key || '');
    if (!want) {
      const d = doc.default_analysis;
      const steady = d && typeof d === 'object' ? String(d.steady || '') : '';
      const analyses = Array.isArray(doc.analysis) ? doc.analysis : [];
      const row = analyses.find((r) => r && String(r.key) === steady);
      const models = row && Array.isArray(row.material_models) ? row.material_models : [];
      want = models.length ? String(models[0]) : '';
    }
    if (!want) continue;
    const rows = Array.isArray(doc.material) ? doc.material : [];
    const hit = rows.find((r) => r && String(r.key) === want);
    if (hit) return hit;
  }
  return null;
}

/** @param {Record<string, any>} p */
function _presetCodes(p) {
  const codes = Array.isArray(p.codes) && p.codes.length ? p.codes : p.library ? [p.library] : [];
  return codes.map((c) => String(c).toUpperCase());
}

/** @param {Record<string, any>} p */
function _presetNames(p) {
  return (Array.isArray(p.names) ? p.names : [p.name]).map((n) => String(n).trim().toLowerCase());
}

/**
 * The preset a saved material record is (the Materials panel's read rule, as
 * src/materialModel.ts presetOf): its preset key, else its library code (one
 * of a preset's codes), else its name (one of a preset's names, any case);
 * no name is the default preset (the one whose codes include DEFAULT), any
 * other name the custom preset. Null when the model is not registered or has
 * no presets. Preset rows: { key, name, values: { field: SI }, legacy_values?,
 * library, codes, names }.
 * @param {unknown} modelKey
 * @param {{ preset?: unknown, library?: unknown, name?: unknown } | null | undefined} record
 * @returns {Record<string, any> | null}
 */
export function materialPresetOf(modelKey, record) {
  const model = materialModel(modelKey);
  const list = model && Array.isArray(model.library) ? model.library.filter((p) => p && p.key) : [];
  if (!list.length) return null;
  const custom = String(model.custom_preset || 'custom');
  const key = String((record && record.preset) || '').trim();
  const byKey = key ? list.find((p) => String(p.key) === key) : undefined;
  if (byKey) return byKey;
  const code = String((record && record.library) || '').trim().toUpperCase();
  const byCode = code ? list.find((p) => _presetCodes(p).includes(code)) : undefined;
  if (byCode) return byCode;
  const name = String((record && record.name) || '').trim().toLowerCase();
  if (!name) {
    return list.find((p) => _presetCodes(p).includes('DEFAULT')) || list.find((p) => p.key !== custom) || list[0];
  }
  return list.find((p) => _presetNames(p).includes(name)) || list.find((p) => String(p.key) === custom) || null;
}

/**
 * The preset that `nameOrKey` names: a preset key, a library code or a fluid
 * name (materialPresetOf's rule); blank is the default preset, anything else
 * the custom preset.
 * @param {unknown} modelKey
 * @param {unknown} nameOrKey
 * @returns {Record<string, any> | null}
 */
export function materialPreset(modelKey, nameOrKey) {
  const raw = String(nameOrKey || '').trim();
  return materialPresetOf(modelKey, { preset: raw, library: raw, name: raw });
}

export function mesherByKey(key) {
  const want = String(key || '');
  return mesherEntries().find((r) => r && String(r.key) === want) || null;
}

/**
 * Host run path for a mesher key ("standard" / "cfmesh" / "snappy_hexdominant"),
 * from the registry row's engine. A plugin mesher that clones a builtin runs
 * through that builtin's path. Unregistered keys return ''.
 * @param {string} key
 */
export function mesherEngineOf(key) {
  const row = mesherByKey(key);
  if (!row) return '';
  return String(row.engine || row.key || '');
}

/**
 * Advanced mesh_engine allow-list derived from registry mesher keys.
 * Builtin product engines are the keys that intersect the historical W20 set;
 * every mesher a plugin registers is a product engine too, so a plugin mesher
 * picked in the Mesh panel is saved and run as picked.
 * Every accepted key is guaranteed present in the registry (no parallel dict).
 */
export function meshEngineKeys() {
  const dump = new Set(mesherKeys());
  const keys = MESH_ENGINE_PRODUCT_KEYS.filter((k) => dump.has(k));
  for (const row of mesherEntries()) {
    const key = row && row.key != null ? String(row.key) : '';
    const plugin = row && row.plugin != null ? String(row.plugin) : 'builtin';
    if (key && plugin !== 'builtin' && !keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) {
    throw new Error(
      'registry.json mesher[] has no product mesh_engine keys ' +
        `(expected intersection with ${MESH_ENGINE_PRODUCT_KEYS.join(', ')})`
    );
  }
  return keys;
}

/**
 * Live set: its contents are replaced in place whenever the registry changes,
 * so modules that imported it see plugin meshers without re-importing.
 * @type {Set<string>}
 */
export const MESH_ENGINES = new Set(meshEngineKeys());

function _syncMeshEngines() {
  let keys;
  try {
    keys = meshEngineKeys();
  } catch {
    return;
  }
  MESH_ENGINES.clear();
  for (const k of keys) MESH_ENGINES.add(k);
}

/** @type {Readonly<Record<string, string>>} */
const TIME_DEPENDENCY_LABELS = Object.freeze({
  steady: 'Steady-state',
  transient: 'Transient',
});

export function timeDependencyLabel(key) {
  const k = String(key || '').trim().toLowerCase();
  return TIME_DEPENDENCY_LABELS[k] || 'Steady-state';
}

/**
 * A new study's defaults for the default analysis: the study_defaults its
 * contract publishes (the Create modal's pick without an explicit analysis).
 * Null when it is not installed (a required plugin failed to load).
 */
export function buildW17DefaultsFromRegistry() {
  const key = defaultAnalysisKey('steady');
  const steady = analysisByKey(key);
  if (!steady) return null;
  const published = studyDefaultsFor(key);
  if (published) return Object.freeze({ ...published });
  // An analysis that publishes no study_defaults: only what its row says.
  return Object.freeze({
    /** Registered AnalysisType key (dump). */
    analysis_type: String(steady.key),
    analysis: String((steady.family && steady.family.label) || steady.label || steady.key),
    analysis_title: String(steady.label || steady.key),
    category: String(steady.category || ''),
    time_dependency: timeDependencyLabel(String(steady.time_dependency || 'steady')),
    algorithm: algorithmLabelFor(String(steady.key)),
  });
}

/**
 * W20 algorithm label + default mesh_engine from dump mesher rows.
 */
export function buildMeshDefaultsFromRegistry() {
  const engines = meshEngineKeys();
  const defaultEngine = engines.includes('standard') ? 'standard' : engines[0];
  const standard = mesherByKey('standard') || mesherByKey(defaultEngine);
  return Object.freeze({
    algorithm_label: String((standard && standard.label) || 'Standard'),
    mesh_engine: defaultEngine,
    mesher_keys: Object.freeze(mesherKeys().slice()),
    mesh_engine_keys: Object.freeze(engines.slice()),
  });
}
