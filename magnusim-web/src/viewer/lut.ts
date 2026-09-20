import vtkLookupTable from '@kitware/vtk.js/Common/Core/LookupTable';

export function createRainbowLut(): ReturnType<typeof vtkLookupTable.newInstance> {
  const lut = vtkLookupTable.newInstance();
  const anyLut = lut as unknown as {
    setHueRange: (a: number, b: number) => void;
    setSaturationRange: (a: number, b: number) => void;
    setValueRange: (a: number, b: number) => void;
    build: () => void;
  };
  anyLut.setHueRange(0.666, 0.0);
  anyLut.setSaturationRange(1, 1);
  anyLut.setValueRange(1, 1);
  anyLut.build();
  return lut;
}

export function setLutRange(lut: { setRange?: (a: number, b: number) => void }, min: number, max: number): void {
  if (!lut || min === max) return;
  try {
    lut.setRange?.(min, max);
  } catch {
    /* ignore */
  }
}
