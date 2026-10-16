/**
 * Which mesher a NEW mesh starts with: one rule, used by the server's createMesh
 * (scripts/w20-mesh.js, through scripts/registry-defaults.js) and by the Mesh form's
 * new-mesh defaults (src/workbench/runtime.js), both from the same registry rows.
 *
 * - The meshers a new mesh can use: the core's product engines that are registered, in
 *   that order, then every mesher a plugin registers.
 * - The app's default: Standard when it is one of them, else the first of them.
 * - A study's analysis may name its own (host API 1.8 `AnalysisType.default_mesher`,
 *   published on its row only when that mesher is registered): it wins when it is one a
 *   new mesh can use, else the app's default.
 *
 * Only a new mesh: an existing mesh keeps its mesher, a copy keeps its source's.
 */

/** Core meshers that are product engines (a pick in the Mesh panel), in this order. */
export const CORE_MESH_ENGINES: readonly string[] = Object.freeze(['standard', 'cfmesh', 'snappy_hexdominant']);

/** A registry mesher row, as far as this needs it. */
export interface MesherKeyRow {
  key?: unknown;
  plugin?: unknown;
}

/** The meshers a new mesh can use, from the registry's mesher rows. */
export function newMeshEngines(rows: readonly (MesherKeyRow | null | undefined)[] | null | undefined): string[] {
  const all = (rows || []).filter((r): r is MesherKeyRow => !!r && r.key != null && String(r.key) !== '');
  const registered = new Set(all.map((r) => String(r.key)));
  const out = CORE_MESH_ENGINES.filter((k) => registered.has(k));
  for (const row of all) {
    const key = String(row.key);
    const plugin = row.plugin != null ? String(row.plugin) : 'builtin';
    if (plugin !== 'builtin' && !out.includes(key)) out.push(key);
  }
  return out;
}

/** The app's default mesher among `engines`: Standard when it is there, else the first ('' when none). */
export function appDefaultMeshEngine(engines: readonly string[]): string {
  return engines.includes('standard') ? 'standard' : engines[0] || '';
}

/**
 * The mesher a new mesh of a study starts with: its analysis row's `default_mesher` when a
 * new mesh can use it, else the app's default.
 */
export function defaultMeshEngine(
  analysisRow: { default_mesher?: unknown } | null | undefined,
  mesherRows: readonly (MesherKeyRow | null | undefined)[] | null | undefined,
): string {
  const engines = newMeshEngines(mesherRows);
  const want = String((analysisRow && analysisRow.default_mesher) || '').trim();
  return want && engines.includes(want) ? want : appDefaultMeshEngine(engines);
}
