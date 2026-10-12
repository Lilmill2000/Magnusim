/**
 * Why a mesh failed, in words the user can act on. The mesher's own error is often
 * a library's ("HXT 3D mesh failed"), and the useful part comes after it in the log:
 * gmsh prints the volume mesher's "PLC Error" lines when its process ends, after the
 * result line, with the point in gmsh's units (metres: the Standard mesher scales the
 * part to metres before meshing).
 */

/** A generator that ended (exited, crashed or was killed) without its result line. */
export const MESHER_GONE_TEXT = 'The mesher stopped without a result.';

const FILL_FAILED = 'The volume mesher could not fill the part';
const TRY_NEXT = 'Try a higher Fineness or the Hex-dominant mesher.';

/** Model units by their size in metres (the STEP file's length unit). */
const UNITS = [
  { name: 'm', scale: 1 },
  { name: 'mm', scale: 0.001 },
  { name: 'cm', scale: 0.01 },
  { name: 'in', scale: 0.0254 },
  { name: 'ft', scale: 0.3048 },
  { name: 'µm', scale: 1e-6 },
];

/** The unit a length scale names ('mm' for 0.001); metres for anything else. */
export function unitForScale(scaleToMetres) {
  const s = Number(scaleToMetres);
  if (Number.isFinite(s) && s > 0) {
    for (const unit of UNITS) {
      if (Math.abs(s - unit.scale) <= unit.scale * 1e-6) return unit;
    }
  }
  return UNITS[0];
}

/**
 * A point given in metres, in the model's unit: "(950, 668, −3) mm". The decimals
 * follow the largest coordinate (three significant figures for it).
 * @param {number[]} metres
 * @param {number | null | undefined} scaleToMetres
 */
export function formatModelPoint(metres, scaleToMetres) {
  const unit = unitForScale(scaleToMetres);
  const v = metres.map((m) => Number(m) / unit.scale);
  if (v.some((x) => !Number.isFinite(x))) return '';
  const big = Math.max(...v.map((x) => Math.abs(x)));
  const decimals = big > 0 ? Math.min(4, Math.max(0, 2 - Math.floor(Math.log10(big)))) : 0;
  const text = (x) => {
    const s = decimals ? x.toFixed(decimals).replace(/\.?0+$/, '') : x.toFixed(0);
    const n = s === '-0' ? '0' : s;
    return n.startsWith('-') ? '−' + n.slice(1) : n;
  };
  return `(${v.map(text).join(', ')}) ${unit.name}`;
}

const NUM = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)';
const PLC_RE = /PLC Error:\s*([^\r\n]*)/g;
const VERTEX_RE = new RegExp(`Vertex:\\s*\\[\\d+\\]\\s*\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\)`);

/**
 * The volume mesher's last "PLC Error" in a log, and the vertex it names (in metres).
 * @param {string} log
 * @returns {{ message: string, vertex: number[] | null } | null}
 */
export function parsePlcError(log) {
  const text = String(log || '');
  let last = null;
  for (const m of text.matchAll(PLC_RE)) last = m;
  if (!last) return null;
  const after = text.slice(last.index + last[0].length, last.index + last[0].length + 400);
  const v = VERTEX_RE.exec(after);
  return {
    message: String(last[1] || '').trim(),
    vertex: v ? [Number(v[1]), Number(v[2]), Number(v[3])] : null,
  };
}

/**
 * The reason a failed generate shows the user.
 * @param {{ error?: string | null, log?: string, scaleToMetres?: number | null, gotResult?: boolean }} info
 *   error: the generator's result error; log: its whole output; scaleToMetres: the
 *   model's length unit in metres (from its step_loaded progress); gotResult: whether a
 *   result line arrived at all.
 */
export function plainMeshFailure({ error, log, scaleToMetres, gotResult } = {}) {
  const raw = String(error || '').trim();
  const plc = parsePlcError(log || '');
  if (plc) {
    const crossing = /vertex lies in a segment|intersect|overlap/i.test(plc.message);
    const where = plc.vertex ? formatModelPoint(plc.vertex, scaleToMetres) : '';
    const what = crossing
      ? `the surface mesh crosses itself${where ? ` near ${where}` : ''}, often at a thin feature`
      : `the surface mesh is not closed and clean${where ? ` near ${where}` : ''}`;
    return `${FILL_FAILED}: ${what}. ${TRY_NEXT}`;
  }
  if (/HXT 3D mesh failed/i.test(raw)) return `${FILL_FAILED}. ${TRY_NEXT}`;
  if (!gotResult) return MESHER_GONE_TEXT;
  return raw || 'The mesher finished without writing a mesh.';
}
