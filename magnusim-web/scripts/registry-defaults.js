// @ts-check
/**
 * Phase 2 land13 — thin dual-defaults consumer.
 * Reads the live registry (worker registry.describe, set by the API server at
 * boot and after every plugin change). Until that arrives, and for offline
 * tooling, it falls back to the committed scripts/generated/registry.json,
 * which lists builtins only. Plugin keys therefore exist only in the live doc.
 *
 * Bank UI still shows "Incompressible" / "k-omega SST"; those labels are
 * derived from dump keys (analysis_type, default_turbulence, default_solver).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_JSON_PATH = join(__dirname, 'generated', 'registry.json');

/** Default AnalysisType key (matches cfddesk.registry.analysis.DEFAULT_STEADY_KEY). */
export const DEFAULT_ANALYSIS_KEY = 'incompressible_steady';
/** Transient sibling (cfddesk.registry.analysis.DEFAULT_TRANSIENT_KEY). */
export const DEFAULT_TRANSIENT_ANALYSIS_KEY = 'incompressible_transient';

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
 * The registered AnalysisType for an analysis family and a time dependency
 * (same rule as cfddesk.registry.analysis.analysis_key_for): the key itself
 * when it already has that time dependency, else its registered sibling
 * (`_steady` ↔ `_transient`), else the key unchanged. Blank or the legacy
 * "incompressible" / "Incompressible" name maps to the builtin pair.
 * @param {string | null | undefined} key
 * @param {string | null | undefined} timeDependency
 */
export function analysisKeyFor(key, timeDependency) {
  const td = timeDependencyKey(timeDependency);
  const raw = String(key || '').trim();
  if (!raw || raw.toLowerCase() === 'incompressible') {
    return td === 'transient' ? DEFAULT_TRANSIENT_ANALYSIS_KEY : DEFAULT_ANALYSIS_KEY;
  }
  const row = analysisByKey(raw);
  if (row && String(row.time_dependency || '') === td) return raw;
  const m = raw.match(/^(.*)_(steady|transient)$/);
  if (m) {
    const sibling = `${m[1]}_${td}`;
    if (analysisByKey(sibling)) return sibling;
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
 * (built from cfddesk.project.transient STEADY_DEFAULTS / TRANSIENT_DEFAULTS,
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

/** Transient run-control defaults (end_time, write_count, max_co, …) from the registry. */
export function transientDefaultsFromRegistry() {
  const d = controlDefaults(DEFAULT_TRANSIENT_ANALYSIS_KEY);
  if (!Object.keys(d).length) {
    throw new Error(`registry.json analysis ${DEFAULT_TRANSIENT_ANALYSIS_KEY} has no control_schema defaults`);
  }
  return Object.freeze(d);
}

/** Steady run-control defaults ({ end_time, write_interval } in iterations) from the registry. */
export function steadyDefaultsFromRegistry() {
  const d = controlDefaults(DEFAULT_ANALYSIS_KEY);
  if (!Object.keys(d).length) {
    throw new Error(`registry.json analysis ${DEFAULT_ANALYSIS_KEY} has no control_schema defaults`);
  }
  return Object.freeze(d);
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
export const TURBULENCE_LABELS = Object.freeze({
  laminar: 'Laminar',
  kEpsilon: 'k-epsilon',
  kOmegaSST: 'k-omega SST',
  LRR: 'LRR',
  SSG: 'SSG',
});

/** @type {Readonly<Record<string, string>>} */
const TIME_DEPENDENCY_LABELS = Object.freeze({
  steady: 'Steady-state',
  transient: 'Transient',
});

/** @type {Readonly<Record<string, string>>} */
const ALGORITHM_FROM_SOLVER = Object.freeze({
  simpleFoam: 'SIMPLE',
  simpleFoam_amgx: 'SIMPLE',
  pimpleFoam: 'PIMPLE',
});

export function turbulenceLabel(key) {
  const k = String(key || '');
  return TURBULENCE_LABELS[k] || k || 'k-omega SST';
}

export function timeDependencyLabel(key) {
  const k = String(key || '').trim().toLowerCase();
  return TIME_DEPENDENCY_LABELS[k] || 'Steady-state';
}

export function algorithmFromSolver(solverKey) {
  const k = String(solverKey || '');
  return ALGORITHM_FROM_SOLVER[k] || 'SIMPLE';
}

function _schemaDefault(entry, prop, fallback) {
  const props =
    entry &&
    entry.schema &&
    entry.schema.properties &&
    typeof entry.schema.properties === 'object'
      ? entry.schema.properties
      : null;
  if (!props || !props[prop] || props[prop].default === undefined) return fallback;
  return props[prop].default;
}

/**
 * W17 product defaults with dump-backed analysis key + label + schema defaults.
 * Bank display name `analysis: 'Incompressible'` remains for the create-sim gate
 * (UI bank string; not a registry key — alias carry until full string replace).
 */
export function buildW17DefaultsFromRegistry() {
  const steady = analysisByKey(DEFAULT_ANALYSIS_KEY);
  if (!steady) {
    throw new Error(
      `registry.json analysis[] missing default key ${DEFAULT_ANALYSIS_KEY}`
    );
  }
  const turbKey = String(
    steady.default_turbulence || _schemaDefault(steady, 'turbulence_model', 'kOmegaSST')
  );
  const timeKey = String(steady.time_dependency || 'steady');
  const solverKey = String(steady.default_solver || 'simpleFoam');
  const category = String(steady.category || 'FLUID DYNAMICS');
  return Object.freeze({
    /** Registered AnalysisType key (dump). */
    analysis_type: String(steady.key),
    /** Bank UI create-sim name (label prefix; gate also accepts dump keys). */
    analysis: 'Incompressible',
    analysis_title: String(steady.label || 'Incompressible Fluid Flow'),
    category,
    flow_group: 'FLOW',
    turbulence_model_key: turbKey,
    turbulence_model: turbulenceLabel(turbKey),
    time_dependency: timeDependencyLabel(timeKey),
    algorithm: algorithmFromSolver(solverKey),
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
