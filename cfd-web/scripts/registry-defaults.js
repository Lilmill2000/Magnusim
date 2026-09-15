/**
 * Phase 2 land13 — thin dual-defaults consumer.
 * Reads committed scripts/generated/registry.json so W17 / MESH_ENGINES
 * product keys come from the dump, not a parallel hard-coded dict.
 *
 * Does NOT invent FILTERS chrome, Node write ban, or prepare_run reroute.
 * Bank UI labels (analysis display name, k-omega SST) stay product strings
 * until describe/dump fill (OUT of this land).
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
  return Object.freeze({
    /** Registered AnalysisType key (dump). */
    analysis_type: String(steady.key),
    /** Bank UI create-sim name (not a dump key — intentional carry). */
    analysis: 'Incompressible',
    analysis_title: String(steady.label || 'Incompressible Fluid Flow'),
    category: 'FLUID DYNAMICS',
    flow_group: 'FLOW',
    /** Bank turbulence label; schema default is kOmegaSST (label map carry). */
    turbulence_model: 'k-omega SST',
    time_dependency: 'Steady-state',
    algorithm: 'SIMPLE',
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
