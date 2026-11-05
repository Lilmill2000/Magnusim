/**
 * One cell across (2D), Hex-dominant's setting (validation gap G5): what the Mesh panel says
 * under it while it is on, from GET /api/mesh/two-d (the rule Generate meshes by,
 * cfddesk/mesh/two_d.py). The Assistant's read_setup mesh reads the same answer.
 */

export interface TwoDEnd {
  faces?: string[];
  bc?: string;
  patch?: string;
}

export interface TwoDAnswer {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  error?: string;
  two_d?: { axis?: string; depth_m?: number; cells_across?: number; front?: TwoDEnd; back?: TwoDEnd };
}

/** The setting's key in Hex-dominant's schema (its own key: saved under mesher_settings). */
export const ONE_CELL_ACROSS = 'one_cell_across';

/** A length in metres as the mesh summary words it (m, mm or µm). */
export function lengthWords(m: unknown): string {
  const v = Number(m);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1) return `${v.toFixed(3).replace(/\.?0+$/, '')} m`;
  if (v >= 1e-3) return `${(v * 1e3).toFixed(v * 1e3 >= 10 ? 1 : 2).replace(/\.?0+$/, '')} mm`;
  return `${(v * 1e6).toFixed(0)} µm`;
}

function facesWords(end: TwoDEnd | undefined): string {
  const faces = (end?.faces || []).map(String).filter(Boolean);
  return faces.length ? faces.join(', ') : 'its end';
}

/** The note under One cell across (2D): how the part is meshed, or why it can't be. */
export function twoDNote(answer: TwoDAnswer | null, loading = false): string {
  if (!answer) return loading ? 'Checking the part…' : '';
  if (answer.ok === false) return `Couldn't check the part: ${answer.error || 'no answer'}`;
  if (!answer.available) return `Not available on this part: ${answer.reason || 'it is not a slab between two Symmetry faces.'} Generate refuses until it is.`;
  const t = answer.two_d || {};
  const front = t.front || {};
  const back = t.back || {};
  const sym =
    front.bc && back.bc && front.bc !== back.bc ? `Symmetry "${front.bc}" and "${back.bc}"` : `Symmetry "${front.bc || back.bc || ''}"`;
  const depth = lengthWords(t.depth_m);
  return `2D: one cell across, ${depth ? `${depth} deep ` : ''}along ${t.axis || '?'}, between ${facesWords(front)} and ${facesWords(back)} (${sym}).`;
}
