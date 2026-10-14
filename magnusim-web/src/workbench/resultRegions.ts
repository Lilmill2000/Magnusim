/**
 * Results of a multi-region case (conjugate heat transfer, host API 1.8).
 *
 * The case lists its regions (`regions` in /api/times and in a field's meta:
 * `{name, role}`, in order). Every surface, slice and iso surface the exporters
 * send keeps a point array `vtkRegion`: each point's region, its index in that
 * list (python/cfddesk/results/regions.py). A field only some regions have (U in
 * the fluid) is NaN in the others: the viewer draws NaN grey and the legend says
 * where the field is not defined (`regionNote`). The region filter shows one
 * region's cells (`polyDataInRegion`).
 */
import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';

/** The point (and cell) array that holds each one's region index. */
export const REGION_ARRAY = 'vtkRegion';

/** The color NaN values are drawn in (a field a region does not have): a neutral grey. */
export const NO_VALUE_RGBA: [number, number, number, number] = [0.72, 0.74, 0.77, 1];

export interface CaseRegion {
  name: string;
  role: string;
}

const REGION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The regions a response lists ([] when it lists none or the list is not valid,
 * two names that differ only in case too: they are one folder on Windows).
 */
export function normalizeRegions(raw: unknown): CaseRegion[] {
  if (!Array.isArray(raw)) return [];
  const out: CaseRegion[] = [];
  for (const row of raw) {
    const name = row && typeof row === 'object' ? (row as { name?: unknown }).name : null;
    const role = row && typeof row === 'object' ? (row as { role?: unknown }).role : null;
    if (typeof name !== 'string' || !REGION_NAME_RE.test(name) || (role !== 'fluid' && role !== 'solid')) return [];
    if (out.some((r) => r.name.toLowerCase() === name.toLowerCase())) return [];
    out.push({ name, role });
  }
  return out;
}

/** A region as the filter lists it: "air (fluid)". */
export function regionLabel(region: CaseRegion): string {
  return `${region.name} (${region.role})`;
}

/**
 * The legend's note for a field some regions do not have, else ''. `field` is the
 * shown name (a vector's magnitude `magU` reads as `U`). Every solid region and
 * only those: "No U in solids (shown grey)"; else the regions by name.
 */
export function regionNote(field: string, without: CaseRegion[], regions: CaseRegion[]): string {
  if (!without.length) return '';
  const base = /^mag[A-Z]/.test(field) ? field.slice(3) : field;
  const solids = regions.filter((r) => r.role === 'solid').map((r) => r.name);
  const missing = without.map((r) => r.name);
  const onlySolids = missing.length === solids.length && missing.every((n) => solids.includes(n));
  const where = onlySolids ? 'solids' : missing.join(', ');
  return `No ${base} in ${where} (shown grey)`;
}

type AnyPolyData = ReturnType<typeof vtkPolyData.newInstance>;

/** Each point's region index (rounded: a slice interpolates it), or null without the array. */
function pointRegions(pd: AnyPolyData): ArrayLike<number> | null {
  const arr = pd.getPointData().getArrayByName(REGION_ARRAY);
  return arr ? (arr.getData() as ArrayLike<number>) : null;
}

/**
 * The regions (indexes) a dataset's cells are drawn in, in order (a cell's region
 * is its first point's; a filtered dataset keeps every point, so its points alone
 * would not say).
 */
export function regionsIn(pd: AnyPolyData | null | undefined): number[] {
  if (!pd) return [];
  const regions = pointRegions(pd);
  if (!regions) return [];
  const seen = new Set<number>();
  for (const get of ['getVerts', 'getLines', 'getPolys', 'getStrips'] as const) {
    const cells = pd[get]();
    const data = cells ? (cells.getData() as ArrayLike<number>) : null;
    if (!data) continue;
    for (let i = 0; i < data.length; i += data[i] + 1) {
      if (data[i] > 0) seen.add(Math.round(regions[data[i + 1]]));
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The cells of `pd` whose points all lie in region `index`: a new dataset that
 * shares the points and point data, its cell data cut to the kept cells. `pd`
 * itself when it carries no region array (a case of one region).
 */
export function polyDataInRegion(pd: AnyPolyData, index: number): AnyPolyData {
  const regions = pointRegions(pd);
  if (!regions) return pd;
  const inRegion = (p: number) => Math.round(regions[p]) === index;
  const out = vtkPolyData.newInstance();
  out.setPoints(pd.getPoints());
  out.getPointData().shallowCopy(pd.getPointData());
  const keptCells: number[] = [];
  let cellId = 0;
  const kinds: Array<['getVerts' | 'getLines' | 'getPolys' | 'getStrips', 'setVerts' | 'setLines' | 'setPolys' | 'setStrips']> = [
    ['getVerts', 'setVerts'],
    ['getLines', 'setLines'],
    ['getPolys', 'setPolys'],
    ['getStrips', 'setStrips'],
  ];
  for (const [get, set] of kinds) {
    const cells = pd[get]();
    const data = cells ? (cells.getData() as ArrayLike<number>) : null;
    if (!data || !data.length) continue;
    const kept: number[] = [];
    for (let i = 0; i < data.length; ) {
      const n = data[i];
      let keep = true;
      for (let k = 1; k <= n; k += 1) {
        if (!inRegion(data[i + k])) {
          keep = false;
          break;
        }
      }
      if (keep) {
        for (let k = 0; k <= n; k += 1) kept.push(data[i + k]);
        keptCells.push(cellId);
      }
      cellId += 1;
      i += n + 1;
    }
    out[set](vtkCellArray.newInstance({ values: Uint32Array.from(kept) }));
  }
  const cellData = pd.getCellData();
  for (let a = 0; a < cellData.getNumberOfArrays(); a += 1) {
    const arr = cellData.getArrayByIndex(a);
    if (!arr) continue;
    const comps = arr.getNumberOfComponents();
    const src = arr.getData() as unknown as ArrayLike<number>;
    // The same typed array kind as the source (VTK keeps a type per array).
    const Ctor = ((src as unknown as { constructor: unknown }).constructor || Float64Array) as new (n: number) => Float64Array;
    const values = new Ctor(keptCells.length * comps);
    keptCells.forEach((c, j) => {
      for (let k = 0; k < comps; k += 1) values[j * comps + k] = src[c * comps + k];
    });
    out.getCellData().addArray(vtkDataArray.newInstance({ name: arr.getName(), numberOfComponents: comps, values }));
  }
  return out;
}
