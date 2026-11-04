// @ts-check
/**
 * A generated mesh's quality as its record keeps it (`live_mesh_result.quality`, RH2): checkMesh's
 * report as numbers (magnusim_sdk.mesh_facts.record_quality). The generator's result carries it;
 * when that is missing (a mesh found on disk, a kept previous mesh), it comes from the
 * `mesh-facts.json` the generator left beside the mesh, while that file still matches the mesh.
 * The Mesh panel's quality line and the Assistant's `read_setup mesh` read it
 * (src/panels/mesh/meshQuality.ts).
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NUMBERS = [
  'max_non_orthogonality',
  'avg_non_orthogonality',
  'severe_non_orthogonal_faces',
  'max_skewness',
  'skewed_faces',
  'max_aspect_ratio',
  'min_volume_m3',
];
const UNITS = new Set(['cells', 'faces', 'edges']);
export const FAILED_MAX = 8;

/** @param {unknown} v */
function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The quality as the record keeps it: `{known: false}`, or the known report's verdict, at most 8
 * failed checks (`check`, `count`, `unit`, `accepted`, and `text` for one the app does not name)
 * and the worst cells. Null for anything that is not a quality.
 * @param {unknown} q
 * @returns {Record<string, any> | null}
 */
export function cleanMeshQuality(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
  const src = /** @type {Record<string, any>} */ (q);
  if (src.known !== true) return { known: false };
  /** @type {Record<string, any>} */
  const out = { known: true, ok: src.ok === true, n_failed: Math.max(0, Math.floor(finite(src.n_failed) ?? 0)) };
  for (const k of NUMBERS) out[k] = finite(src[k]);
  out.failed = (Array.isArray(src.failed) ? src.failed : [])
    .filter((f) => f && typeof f === 'object' && typeof f.check === 'string')
    .slice(0, FAILED_MAX)
    .map((f) => {
      const count = finite(f.count);
      /** @type {Record<string, any>} */
      const row = {
        check: String(f.check).slice(0, 40),
        count: count === null ? null : Math.floor(count),
        unit: UNITS.has(f.unit) ? f.unit : null,
        accepted: f.accepted === true,
      };
      if (typeof f.text === 'string' && f.text) row.text = f.text.slice(0, 120);
      return row;
    });
  return out;
}

const STAMP_FILES = ['points', 'faces', 'owner', 'neighbour', 'boundary'];

/**
 * The mesh files' stamp as magnusim_sdk.courant_rates.mesh_stamp writes it: [name, size, mtime ns].
 * @param {string} polyDir
 */
export function meshStamp(polyDir) {
  /** @type {Array<[string, number, string]>} */
  const out = [];
  for (const name of STAMP_FILES) {
    for (const file of [name, `${name}.gz`]) {
      try {
        const st = statSync(join(polyDir, file), { bigint: true });
        if (st.isFile()) out.push([file, Number(st.size), String(st.mtimeNs)]);
      } catch {
        /* not there */
      }
    }
  }
  return out;
}

/**
 * The quality in `mesh-facts.json` beside the mesh in `caseDir`, as the record keeps it; null when
 * there is none, or it was written for another mesh (its stamp differs from the mesh files').
 * @param {string | null | undefined} caseDir
 */
export function meshFactsQuality(caseDir) {
  if (!caseDir) return null;
  let facts;
  try {
    facts = JSON.parse(readFileSync(join(caseDir, 'mesh-facts.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!facts || typeof facts !== 'object' || facts.v !== 1 || !Array.isArray(facts.stamp)) return null;
  const now = meshStamp(join(caseDir, 'constant', 'polyMesh'));
  const kept = facts.stamp.map((/** @type {any} */ s) => (Array.isArray(s) ? [String(s[0]), Number(s[1]), String(s[2])] : null));
  if (JSON.stringify(kept) !== JSON.stringify(now)) return null;
  return cleanMeshQuality(facts.quality);
}
