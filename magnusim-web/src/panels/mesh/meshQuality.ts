/**
 * A generated mesh's quality (RH2): what the Mesh panel's quality line shows, and what the
 * Assistant's `read_setup mesh` answers, from one reading of the mesh record.
 *
 * The record keeps checkMesh's report as numbers in `live_mesh_result.quality` (the generator's
 * result, scripts/mesh-quality.js). Records written before RH2 have none; a record that carried
 * the worst cells as top-level keys (`max_non_orthogonality`, `max_non_ortho`, `max_skewness`,
 * `max_aspect_ratio`) is still read.
 */

export interface MeshQualityFailed {
  /** A short name: skewness, aspect_ratio, negative_volume, non_orthogonality, face_pyramids, ... or other. */
  check: string;
  count: number | null;
  unit: 'cells' | 'faces' | 'edges' | null;
  /** Standard and cfMesh keep a mesh whose only failures are skewed faces and up to 8 high aspect ratio cells. */
  accepted: boolean;
  /** checkMesh's own words for a check the app does not name. */
  text?: string;
}

export interface MeshQuality {
  /** checkMesh's verdict, when its report gave one. */
  ok: boolean | null;
  n_failed: number;
  failed: MeshQualityFailed[];
  /** Degrees. */
  max_non_orthogonality: number | null;
  max_skewness: number | null;
  max_aspect_ratio: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The quality of a mesh record's `live_mesh_result` (or of the record itself), or null when it is
 * not known: no checkMesh report (a mesh made before RH2, a mesher without checkMesh), or a report
 * that never reached its verdict.
 */
export function meshQualityOf(live: unknown): MeshQuality | null {
  const r = rec(live);
  if (!r) return null;
  const q = rec(r.quality);
  if (q) {
    if (q.known !== true) return null;
    const failed = (Array.isArray(q.failed) ? q.failed : [])
      .map(rec)
      .filter((f): f is Record<string, unknown> => !!f && typeof f.check === 'string')
      .map((f) => {
        const unit = f.unit === 'cells' || f.unit === 'faces' || f.unit === 'edges' ? f.unit : null;
        const row: MeshQualityFailed = { check: String(f.check), count: num(f.count), unit, accepted: f.accepted === true };
        if (typeof f.text === 'string' && f.text) row.text = f.text;
        return row;
      });
    return {
      ok: typeof q.ok === 'boolean' ? q.ok : null,
      n_failed: Math.max(num(q.n_failed) ?? 0, failed.length),
      failed,
      max_non_orthogonality: num(q.max_non_orthogonality),
      max_skewness: num(q.max_skewness),
      max_aspect_ratio: num(q.max_aspect_ratio),
    };
  }
  // The older shape: the worst cells as top-level keys of the record.
  const ortho = num(r.max_non_orthogonality) ?? num(r.max_non_ortho);
  const skew = num(r.max_skewness);
  const aspect = num(r.max_aspect_ratio);
  if (ortho === null && skew === null && aspect === null) return null;
  return { ok: null, n_failed: 0, failed: [], max_non_orthogonality: ortho, max_skewness: skew, max_aspect_ratio: aspect };
}

/**
 * A number as the line writes it: one decimal below 10, else whole and grouped (1,234); above a
 * million "over 1,000,000" (a cell turned inside out reads an aspect ratio of 4.5e93, which the
 * line wrote out as 94 digits).
 */
function plain(v: number): string {
  if (Math.abs(v) > 1e6) return 'over 1,000,000';
  return Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US');
}

/** "Worst cells: 78° non-orthogonal, skewness 3.8, aspect ratio 12", or null with no number. */
export function worstCellsLine(q: MeshQuality): string | null {
  const bits: string[] = [];
  if (q.max_non_orthogonality !== null) bits.push(`${Math.round(q.max_non_orthogonality)}° non-orthogonal`);
  if (q.max_skewness !== null) bits.push(`skewness ${plain(q.max_skewness)}`);
  if (q.max_aspect_ratio !== null) bits.push(`aspect ratio ${plain(q.max_aspect_ratio)}`);
  return bits.length ? `Worst cells: ${bits.join(', ')}` : null;
}

function counted(n: number | null, one: string, many: string, none: string): string {
  if (n === null) return none;
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** One failed check in words: "22 highly skewed faces". */
export function failedCheckWords(f: MeshQualityFailed): string {
  const n = f.count;
  switch (f.check) {
    case 'skewness':
      return counted(n, 'highly skewed face', 'highly skewed faces', 'highly skewed faces');
    case 'aspect_ratio':
      return counted(n, 'cell with a high aspect ratio', 'cells with a high aspect ratio', 'cells with a high aspect ratio');
    case 'negative_volume':
      return counted(n, 'cell with a negative volume', 'cells with a negative volume', 'cells with a negative volume');
    case 'non_orthogonality':
      return counted(n, 'face over 90° non-orthogonal', 'faces over 90° non-orthogonal', 'faces over 90° non-orthogonal');
    case 'face_pyramids':
      return counted(n, 'wrongly oriented face', 'wrongly oriented faces', 'wrongly oriented faces');
    case 'face_area':
      return counted(n, 'face with no area', 'faces with no area', 'faces with no area');
    case 'open_cells':
      return counted(n, 'open cell', 'open cells', 'open cells');
    case 'boundary_openness':
      return 'the boundary is not closed';
    case 'non_aligned_edges':
      return counted(n, 'edge out of line with the 2D directions', 'edges out of line with the 2D directions', 'edges out of line with the 2D directions');
    case 'face_order':
      return counted(n, 'face out of order', 'faces out of order', 'faces out of order');
    default:
      return (f.text || 'another check').replace(/\s+/g, ' ').trim();
  }
}

/** "checkMesh failed 2 checks: 22 highly skewed faces, 36 cells with a high aspect ratio.", or null. */
export function failedChecksLine(q: MeshQuality): string | null {
  if (!q.n_failed) return null;
  const n = q.n_failed;
  const list = q.failed.map(failedCheckWords).join(', ');
  return `checkMesh failed ${n} check${n === 1 ? '' : 's'}${list ? `: ${list}` : ''}.`;
}

/** What the Mesh panel shows of a mesh's quality, line by line (empty when it is not known). */
export function meshQualityLines(q: MeshQuality | null): string[] {
  if (!q) return [];
  return [worstCellsLine(q), failedChecksLine(q)].filter((s): s is string => !!s);
}
