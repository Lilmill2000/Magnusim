// @ts-check
/**
 * Phase 2 land13 — thin dual-defaults consumer.
 * Reads committed scripts/generated/registry.json so W17 / MESH_ENGINES
 * product keys come from the dump, not a parallel hard-coded dict.
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

/** Mesher keys used as W20 advanced.mesh_engine (not algorithm-only backends). */
const MESH_ENGINE_PRODUCT_KEYS = Object.freeze(['standard', 'cfmesh']);

let _cache = null;

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
}

function _rows(kind) {
  const doc = loadCommittedRegistry();
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

export function mesherByKey(key) {
  const want = String(key || '');
  return mesherEntries().find((r) => r && String(r.key) === want) || null;
}

/**
 * Advanced mesh_engine allow-list derived from dump mesher keys.
 * Product engines are the dump keys that intersect the historical W20 set
 * (standard / cfmesh). snappy_hexdominant stays a Hex-dominant algorithm path.
 * Every accepted key is guaranteed present in the dump (no silent parallel dict).
 */
export function meshEngineKeys() {
  const dump = new Set(mesherKeys());
  const keys = MESH_ENGINE_PRODUCT_KEYS.filter((k) => dump.has(k));
  if (keys.length === 0) {
    throw new Error(
      'registry.json mesher[] has no product mesh_engine keys ' +
        `(expected intersection with ${MESH_ENGINE_PRODUCT_KEYS.join(', ')})`
    );
  }
  return keys;
}

/** @type {Set<string>} */
export const MESH_ENGINES = new Set(meshEngineKeys());

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
  const passive = _schemaDefault(steady, 'passive_species', 0);
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
    passive_species: String(passive),
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
