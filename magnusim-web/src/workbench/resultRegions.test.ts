import vtkCellArray from '@kitware/vtk.js/Common/Core/CellArray';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkPoints from '@kitware/vtk.js/Common/Core/Points';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import { describe, expect, it } from 'vitest';
import { REGION_ARRAY, normalizeRegions, polyDataInRegion, regionLabel, regionNote, regionsIn } from './resultRegions';

const REGIONS = [
  { name: 'air', role: 'fluid' },
  { name: 'aluminium_6061', role: 'solid' },
];

/** Two triangles in region 0 (air) and one in region 1, points not shared (as the merge leaves them). */
function twoRegionSurface(withRegion = true) {
  const pd = vtkPolyData.newInstance();
  const pts = vtkPoints.newInstance();
  pts.setData(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]), 3);
  pd.setPoints(pts);
  pd.setPolys(vtkCellArray.newInstance({ values: Uint32Array.from([3, 0, 1, 2, 3, 1, 3, 2, 3, 4, 5, 6]) }));
  const t = Float32Array.from([300, 301, 302, 303, 350, 351, 352]);
  const u = Float32Array.from([1, 2, 3, 4, NaN, NaN, NaN]);
  pd.getPointData().addArray(vtkDataArray.newInstance({ name: 'T', values: t }));
  pd.getPointData().addArray(vtkDataArray.newInstance({ name: 'magU', values: u }));
  if (withRegion) {
    // A slice interpolates the index: 0.9999999 is still region 1.
    pd.getPointData().addArray(vtkDataArray.newInstance({ name: REGION_ARRAY, values: Float32Array.from([0, 0, 0, 0, 1, 0.9999999, 1]) }));
  }
  pd.getCellData().addArray(vtkDataArray.newInstance({ name: 'T', values: Float64Array.from([300.5, 301.5, 351]) }));
  return pd;
}

describe('result regions', () => {
  it('reads the regions a response lists', () => {
    expect(normalizeRegions(REGIONS)).toEqual(REGIONS);
    expect(normalizeRegions(undefined)).toEqual([]);
    expect(normalizeRegions([{ name: 'air', role: 'gas' }])).toEqual([]);
    expect(normalizeRegions([{ name: 'a b', role: 'fluid' }])).toEqual([]);
    expect(normalizeRegions([REGIONS[0], REGIONS[0]])).toEqual([]);
    // One folder on Windows: names that differ only in case are one region listed twice.
    expect(normalizeRegions([{ name: 'Air', role: 'fluid' }, REGIONS[0]])).toEqual([]);
    expect(regionLabel(REGIONS[1])).toBe('aluminium_6061 (solid)');
  });

  it('says where a field is not defined, in plain words', () => {
    expect(regionNote('magU', [REGIONS[1]], REGIONS)).toBe('No U in solids (shown grey)');
    expect(regionNote('T', [], REGIONS)).toBe('');
    const three = [...REGIONS, { name: 'fan_air', role: 'fluid' }];
    expect(regionNote('k', [three[2]], three)).toBe('No k in fan_air (shown grey)');
  });

  it("keeps one region's cells, its points and point data shared", () => {
    const pd = twoRegionSurface();
    expect(regionsIn(pd)).toEqual([0, 1]);
    const air = polyDataInRegion(pd, 0);
    expect(Array.from(air.getPolys().getData())).toEqual([3, 0, 1, 2, 3, 1, 3, 2]);
    expect(air.getPoints()).toBe(pd.getPoints());
    expect(air.getPointData().getArrayByName('T').getData()).toBe(pd.getPointData().getArrayByName('T').getData());
    expect(Array.from(air.getCellData().getArrayByName('T').getData())).toEqual([300.5, 301.5]);
    // What it draws is the region's cells only (its points stay all there).
    expect(regionsIn(air)).toEqual([0]);
    const solid = polyDataInRegion(pd, 1);
    expect(regionsIn(solid)).toEqual([1]);
    expect(Array.from(solid.getPolys().getData())).toEqual([3, 4, 5, 6]);
    expect(Array.from(solid.getCellData().getArrayByName('T').getData())).toEqual([351]);
    expect(polyDataInRegion(pd, 2).getPolys().getNumberOfCells()).toBe(0);
  });

  it('leaves a case of one region as it is', () => {
    const pd = twoRegionSurface(false);
    expect(regionsIn(pd)).toEqual([]);
    expect(polyDataInRegion(pd, 0)).toBe(pd);
  });
});
